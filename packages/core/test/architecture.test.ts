import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Kronos, TeamBoard, detectProjectChecks, evalConfigs, failureHighlights, messageText, parseEvalSuite, runEvalSuite } from '@kronos/core';
import type { ToolContext } from '@kronos/core';
import { skillManageTool } from '../src/tools/agentic.js';
import { makeRuntime, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await makeRuntime();
});
afterEach(async () => {
  await env.cleanup();
});

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'demo', scripts });

describe('project checks', () => {
  it('finds a node project’s checks and skips the npm placeholder test script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kronos-checks-'));
    writeFileSync(join(dir, 'package.json'), pkg({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'echo "Error: no test specified" && exit 1', build: 'vite build' }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(detectProjectChecks(dir)).toEqual([
      { name: 'typecheck', command: 'pnpm run typecheck', source: 'package.json' },
      { name: 'lint', command: 'pnpm run lint', source: 'package.json' },
      { name: 'build', command: 'pnpm run build', source: 'package.json' },
    ]);
  });

  it('knows Rust, Go, Python and Makefile projects', () => {
    const rust = mkdtempSync(join(tmpdir(), 'kronos-checks-'));
    writeFileSync(join(rust, 'Cargo.toml'), '[package]\nname = "x"\n');
    expect(detectProjectChecks(rust).map((c) => c.command)).toContain('cargo test');
    const go = mkdtempSync(join(tmpdir(), 'kronos-checks-'));
    writeFileSync(join(go, 'go.mod'), 'module x\n');
    expect(detectProjectChecks(go).map((c) => c.name)).toEqual(['typecheck', 'test', 'build']);
    const py = mkdtempSync(join(tmpdir(), 'kronos-checks-'));
    writeFileSync(join(py, 'pyproject.toml'), '[tool.pytest.ini_options]\n[tool.ruff]\n');
    expect(detectProjectChecks(py).map((c) => c.command)).toEqual(['ruff check .', 'python -m pytest -q']);
    const make = mkdtempSync(join(tmpdir(), 'kronos-checks-'));
    writeFileSync(join(make, 'Makefile'), 'build:\n\tcc x.c\ncheck:\n\t./run-tests\n');
    expect(detectProjectChecks(make).map((c) => c.command)).toEqual(['make check', 'make build']);
  });

  it('pulls the failing lines out of noisy output', () => {
    const out = 'setup ok\nrunning 3 tests\n FAIL src/cart.test.ts > totals\nAssertionError: expected 3 to be 4\nok 2\n';
    expect(failureHighlights(out)).toEqual([' FAIL src/cart.test.ts > totals', 'AssertionError: expected 3 to be 4']);
  });

  it('lists the checks in the system prompt', async () => {
    writeFileSync(join(env.workspace, 'package.json'), pkg({ test: 'node -e "process.exit(0)"' }));
    const a = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    await a.run('hello');
    expect(env.rt.sessions.get(a.id)?.systemPrompt).toContain('Project checks: test `npm test` — run them with the verify tool');
  });
});

describe('verify tool and the verification guard', () => {
  it('reports PASS for passing checks and FAIL with the failing lines first', async () => {
    writeFileSync(join(env.workspace, 'package.json'), pkg({ test: 'node -e "process.exit(0)"' }));
    const a = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    await a.run('verify');
    const result = () => {
      const tool = env.rt.sessions.messages(a.id).flatMap((m) => m.parts).filter((p) => p.type === 'tool_result' && p.toolName === 'verify');
      return tool[tool.length - 1] as { content: string; isError?: boolean };
    };
    expect(result().content).toContain('VERIFY: PASS (1/1 checks passed)');
    writeFileSync(join(env.workspace, 'package.json'), pkg({ test: 'node -e "console.log(\'FAIL cart totals\'); process.exit(1)"' }));
    await a.run('verify');
    expect(result().isError).toBe(true);
    expect(result().content).toMatch(/VERIFY: FAIL \(0\/1 checks passed\)[\s\S]*failing lines[\s\S]*FAIL cart totals/);
  });

  it('asks once for verification when files changed and nothing was verified', async () => {
    writeFileSync(join(env.workspace, 'package.json'), pkg({ test: 'node -e "process.exit(0)"' }));
    const a = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    const res = await a.run('create file notes.md');
    const msgs = env.rt.sessions.messages(a.id);
    const notes = msgs.filter((m) => m.meta?.kind === 'note' && messageText(m).includes('have not run verify'));
    expect(notes).toHaveLength(1);
    const verified = msgs.flatMap((m) => m.parts).some((p) => p.type === 'tool_result' && p.toolName === 'verify' && p.content.includes('VERIFY: PASS'));
    expect(verified).toBe(true);
    expect(res.stopReason).toBe('end_turn');
  });

  it('does not nag when the project has no checks or the guard is off', async () => {
    const a = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    await a.run('create file notes.md');
    expect(env.rt.sessions.messages(a.id).some((m) => messageText(m).includes('have not run verify'))).toBe(false);

    writeFileSync(join(env.workspace, 'package.json'), pkg({ test: 'node -e "process.exit(0)"' }));
    env.rt.updateConfig({ agent: { verifyBeforeFinish: false } });
    const b = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    await b.run('create file other.md');
    expect(env.rt.sessions.messages(b.id).some((m) => messageText(m).includes('have not run verify'))).toBe(false);
  });
});

describe('team board', () => {
  it('lets members claim, share and finish work without stepping on each other', () => {
    const board = new TeamBoard(['api', 'ui']);
    const a = board.add('define the cart API', 'api');
    const extra = board.add('write integration tests');
    expect(() => board.claim(a.id, 'ui')).toThrow(/claimed by api/);
    board.claim(extra.id, 'ui');
    expect(() => board.complete(extra.id, 'api')).toThrow(/only the owner/);
    board.post('api', 'Cart API: GET /cart returns {items, total}');
    board.post('ui', 'using GET /cart');
    board.complete(extra.id, 'ui', 'added 3 tests');
    expect(board.read(0, 'ui').map((p) => p.text)).toEqual(['Cart API: GET /cart returns {items, total}']);
    expect(board.read(1).map((p) => p.author)).toEqual(['ui']);
    expect(board.render()).toContain(`${extra.id} [done · ui] write integration tests — added 3 tests`);
  });

  it('gives parallel subagents a shared board and leaves solo agents without one', async () => {
    const a = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    await a.run('run these in parallel');
    const children = env.rt.sessions.list({ includeChildren: true }).filter((s) => s.parentId === a.id);
    expect(children).toHaveLength(2);
    for (const child of children) {
      const rec = env.rt.sessions.get(child.id)!;
      expect(rec.toolNames).toContain('team_board');
      expect(rec.systemPrompt).toContain('# Team board');
    }
    expect(env.rt.sessions.get(a.id)?.toolNames).not.toContain('team_board');
  });
});

describe('skill governance', () => {
  const body = '# Release notes\n\n1. Read `git log` since the last tag.\n2. Group commits by type.\n3. Verify every PR link resolves.\n';

  it('admits reusable skills and rejects secrets, task-specific values and duplicates', () => {
    const reg = env.rt.skills;
    expect(reg.admit({ name: 'ship-notes', description: 'Draft release notes from git history; use before tagging a release.', body }).ok).toBe(true);
    const secret = reg.admit({ name: 'deploy', description: 'Deploy the app to production with the CLI.', body: 'export TOKEN=sk-ant-abcdefghijklmnopqrstuvwxyz123456' });
    expect(secret.problems.join(' ')).toMatch(/secret/);
    const specific = reg.admit({ name: 'fix-build', description: 'Fix the failing build in the workspace.', body: 'cd /tmp/kronos-e2e-ws-Ab12Cd && npm test' });
    expect(specific.problems.join(' ')).toMatch(/temporary directory|throwaway workspace/);
    expect(reg.admit({ name: 'x', description: 'short', body }).problems.join(' ')).toMatch(/description/);
    reg.create({ name: 'ship-notes', description: 'Draft release notes from git history; use before tagging a release.', body });
    const twin = reg.admit({ name: 'ship_notes', description: 'Draft release notes from the git history before tagging a release.', body });
    expect(twin.problems.join(' ')).toMatch(/duplicates the existing skill "ship-notes"/);
  });

  it('keeps history, rolls back, and refuses a change that was already rolled back', () => {
    const reg = env.rt.skills;
    reg.create({ name: 'ship-notes', description: 'Draft release notes from git history; use before tagging a release.', body });
    const bad = `${body}4. Push the tag immediately.\n`;
    reg.update('ship-notes', { body: bad });
    expect(reg.get('ship-notes')?.version).toBe('1.0.1');
    expect(reg.history('ship-notes').map((r) => r.version)).toEqual(['1.0.0']);
    const restored = reg.rollback('ship-notes');
    expect(restored.version).toBe('1.0.0');
    expect(reg.read('ship-notes').content).not.toContain('Push the tag');
    expect(reg.admit({ name: 'ship-notes', body: bad, existing: 'ship-notes' }).problems.join(' ')).toMatch(/rolled back/);
    // deleted skills come back too
    reg.delete('ship-notes');
    expect(reg.get('ship-notes')).toBeUndefined();
    expect(reg.rollback('ship-notes').name).toBe('ship-notes');
  });

  it('enforces a per-session edit budget for the agent', async () => {
    env.rt.updateConfig({ skills: { editBudget: 1 } });
    const agent = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    const ctx = { runtime: env.rt, agent, sessionId: agent.id, cwd: env.workspace } as unknown as ToolContext;
    const first = await skillManageTool.execute({ action: 'create', name: 'changelog', description: 'Maintain CHANGELOG.md entries in Keep a Changelog format.', body }, ctx);
    expect(first.isError).toBeFalsy();
    const second = await skillManageTool.execute({ action: 'patch', name: 'changelog', old_text: 'Group commits by type.', new_text: 'Group commits by scope.' }, ctx);
    expect(second.isError).toBe(true);
    expect(second.content).toMatch(/edit budget/);
    // the count lives in the session, so a rebuilt agent does not get a fresh budget
    env.rt.releaseAgent(agent.id);
    expect(env.rt.agent(agent.id).skillEditsLeft()).toBe(0);
  });

  it('suggests pruning agent-written skills that are stale or keep failing', () => {
    env.rt.skills.create({ name: 'stale-one', description: 'A procedure nobody has needed for months.', body });
    env.rt.skills.create({ name: 'flaky-one', description: 'A procedure whose runs usually fail.', body });
    env.rt.recordSkillUse('flaky-one');
    env.rt.recordSkillOutcome(['flaky-one'], false);
    env.rt.recordSkillOutcome(['flaky-one'], false);
    env.rt.recordSkillOutcome(['flaky-one'], false);
    env.rt.recordSkillOutcome(['flaky-one'], true);
    const later = Date.now() + 61 * 86_400_000;
    const list = env.rt.skillPruneCandidates(later);
    expect(list.find((p) => p.name === 'stale-one')?.reason).toMatch(/never used/);
    const now = env.rt.skillPruneCandidates();
    expect(now.find((p) => p.name === 'flaky-one')?.reason).toMatch(/failed 3 of 4/);
    expect(now.some((p) => p.name === 'stale-one')).toBe(false);
  });
});

describe('eval harness', () => {
  it('parses suites and validates checks', () => {
    const suite = parseEvalSuite('name: smoke\nrepeats: 2\nmatrix:\n  effort: [low, high]\ncases:\n  - name: hi\n    prompt: hello\n    checks:\n      - contains: Kronos\n');
    expect(suite.repeats).toBe(2);
    expect(evalConfigs(suite, { model: 'kronos:demo', effort: 'medium' }).map((c) => c.id)).toEqual(['kronos:demo · low', 'kronos:demo · high']);
    expect(() => parseEvalSuite('cases:\n  - prompt: x\n    checks:\n      - bogus: 1\n')).toThrow(/unknown check/);
    expect(() => parseEvalSuite('matrix:\n  effort: [turbo]\ncases: []\n')).toThrow(/unknown effort/);
  });

  it('runs cases in isolated runtimes and reports pass rate with spread', async () => {
    const suite = parseEvalSuite(`
name: demo
repeats: 2
cases:
  - name: lists files
    prompt: list the files here
    files: { "README.md": "# fixture" }
    checks:
      - contains: README.md
      - max_tool_calls: 5
  - name: writes a file
    prompt: create file notes.md
    checks:
      - file: notes.md
      - command: test -f notes.md
  - name: impossible
    prompt: hello
    checks:
      - contains: "this text never appears"
`);
    const configs = evalConfigs(suite, { model: 'kronos:demo', effort: 'medium' });
    const homes = new Set<string>();
    const { runs, summary } = await runEvalSuite(suite, configs, {
      createRuntime: (cfg, home) => {
        homes.add(home);
        return Kronos.create({ home, cwd: home, connectMcp: false, logLevel: 'silent', overrides: { model: { default: cfg.model, effort: cfg.effort }, skills: { claudeCompat: false } } });
      },
    });
    expect(runs).toHaveLength(6);
    expect(homes.size).toBe(6);
    const s = summary[0]!;
    expect(s.perCase['lists files']).toEqual({ passed: 2, runs: 2 });
    expect(s.perCase['writes a file']).toEqual({ passed: 2, runs: 2 });
    expect(s.perCase.impossible).toEqual({ passed: 0, runs: 2 });
    expect(s.passRate).toBeCloseTo(2 / 3);
    expect(s.stdev).toBe(0);
    expect(s.meanTokens).toBeGreaterThan(0);
    expect(runs.find((r) => r.case === 'impossible')?.checks[0]).toMatchObject({ ok: false });
  });
});

// keeps the fixture helper honest: the workspace from makeRuntime is writable
it('test workspace is writable', () => {
  mkdirSync(join(env.workspace, 'sub'), { recursive: true });
  writeFileSync(join(env.workspace, 'sub', 'x.txt'), 'x');
});
