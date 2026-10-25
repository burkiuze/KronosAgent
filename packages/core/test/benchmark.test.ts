import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { parseEvalSuite, type EvalCheck } from '../src/eval/runner.js';
import { runShell } from '../src/util/process.js';

/**
 * The coding benchmark is only worth something if every case is solvable and its checks cannot
 * be passed by doing nothing: each case must fail on its starting files and pass with the
 * reference solution.
 */

const dir = resolve(__dirname, '../../../examples/evals');
const suite = parseEvalSuite(readFileSync(join(dir, 'coding.yaml'), 'utf8'));
const solutions = YAML.parse(readFileSync(join(dir, 'coding.solutions.yaml'), 'utf8')) as Record<string, Record<string, string>>;

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** Results of the workspace checks (answer-text checks need an agent and are skipped). */
async function check(root: string, checks: EvalCheck[]): Promise<{ label: string; ok: boolean; output?: string }[]> {
  const out: { label: string; ok: boolean; output?: string }[] = [];
  for (const c of checks) {
    if (c.command !== undefined) {
      const r = await runShell(c.command, { cwd: root, timeoutMs: 60_000 });
      out.push({ label: c.command.slice(0, 80), ok: r.exitCode === 0, output: r.output.slice(-600) });
    }
    if (c.file !== undefined) out.push({ label: `file ${c.file}`, ok: existsSync(join(root, c.file)) });
    if (c.file_contains) {
      const p = join(root, c.file_contains.path);
      out.push({ label: `${c.file_contains.path} contains`, ok: existsSync(p) && readFileSync(p, 'utf8').includes(c.file_contains.text) });
    }
  }
  return out;
}

describe('coding benchmark', () => {
  it('has a reference solution for every case', () => {
    expect(suite.cases.length).toBeGreaterThanOrEqual(15);
    expect(Object.keys(solutions).sort()).toEqual(suite.cases.map((c) => c.name).sort());
  });

  for (const c of suite.cases) {
    it(`"${c.name}" fails as given and passes when solved`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'kronos-bench-'));
      try {
        write(root, c.files ?? {});
        const before = await check(root, c.checks);
        expect(before.length).toBeGreaterThan(0);
        expect(before.some((r) => !r.ok), `the starting files already pass: ${JSON.stringify(before)}`).toBe(true);
        write(root, solutions[c.name] ?? {});
        const after = await check(root, c.checks);
        expect(after.filter((r) => !r.ok), 'the reference solution fails').toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
