import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderError, messageText, parseStructured } from '@kronos/core';
import type { ChatResponse, Message, ModelInfo, Provider, ToolCallPart } from '@kronos/core';
import { syntaxProblems } from '../src/tools/diagnostics.js';
import { makeRuntime, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await makeRuntime();
});
afterEach(async () => {
  await env.cleanup();
});

const usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
const inject = (id: string, provider: Provider) => (env.rt.providers as unknown as { cache: Map<string, Provider> }).cache.set(id, provider);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = (agent: unknown) => agent as any;
const userTexts = (msgs: Message[]) => msgs.filter((m) => m.role === 'user' && m.meta?.kind !== 'summary' && m.parts.some((p) => p.type === 'text')).map(messageText);

describe('compaction', () => {
  it('keeps the most recent turns verbatim and archives the rest, still searchable', async () => {
    const s = env.rt.createSession({ source: 'test' });
    const agent = env.rt.agent(s.id);
    for (const word of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']) await agent.run(`list files for ${word}`);
    const before = env.rt.sessions.messages(s.id).length;
    const r = await agent.compact();
    expect(r.after).toBeLessThan(r.before);
    const live = env.rt.sessions.messages(s.id);
    expect(live[0]?.meta?.kind).toBe('summary');
    expect(userTexts(live)).toEqual(['list files for CHARLIE', 'list files for DELTA']); // keepRecentTurns: 2
    const archived = env.rt.sessions.archivedMessages(s.id);
    expect(archived.length + live.length - 1).toBe(before);
    expect(userTexts(archived)).toEqual(['list files for ALPHA', 'list files for BRAVO']);
    // the user's own earlier words travel along verbatim (Codex-style)
    expect(messageText(live[0]!)).toMatch(/<earlier_user_messages>\n<message>\nlist files for ALPHA\n<\/message>\n<message>\nlist files for BRAVO\n<\/message>/);
    expect(env.rt.sessions.search('BRAVO').some((h) => h.sessionId === s.id)).toBe(true);
    expect((await agent.run('list files again')).stopReason).toBe('end_turn');
    // a second compaction appends to the archive
    await agent.compact();
    expect(userTexts(env.rt.sessions.archivedMessages(s.id))).toEqual(['list files for ALPHA', 'list files for BRAVO', 'list files for CHARLIE']);
    // …and survive the next compaction, still in order
    const again = messageText(env.rt.sessions.messages(s.id)[0]!);
    expect(again.indexOf('list files for ALPHA')).toBeLessThan(again.indexOf('list files for CHARLIE'));
    expect(again.match(/list files for ALPHA/g)).toHaveLength(1);
  });

  it('clears old tool outputs from the context but not from the stored session', async () => {
    writeFileSync(join(env.workspace, 'big.txt'), 'x'.repeat(5000));
    const s = env.rt.createSession({ source: 'test' });
    const agent = env.rt.agent(s.id);
    for (let i = 0; i < 3; i++) await agent.run('read big.txt');
    const resultsIn = (msgs: Message[]) => msgs.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result') as { content: string; meta?: { cleared?: boolean } }[];
    const r = internals(agent).clearOldToolResults(1);
    expect(r.count).toBeGreaterThan(0);
    const live = resultsIn(internals(agent).messages);
    expect(live.at(-1)?.meta?.cleared).toBeUndefined();
    expect(live.filter((p) => p.meta?.cleared)).toHaveLength(r.count);
    expect(live.find((p) => p.meta?.cleared)?.content).toMatch(/Output cleared to save context/);
    expect(resultsIn(env.rt.sessions.messages(s.id)).some((p) => p.meta?.cleared)).toBe(false);
    // clearing twice does nothing more
    expect(internals(agent).clearOldToolResults(1).count).toBe(0);
    // a compaction that keeps those turns stores their original outputs, not the stubs
    await agent.compact();
    expect(resultsIn(env.rt.sessions.messages(s.id)).some((p) => p.meta?.cleared)).toBe(false);
  });

  it('trims instead of failing the task when the summary cannot be made', async () => {
    const s = env.rt.createSession({ source: 'test' });
    const agent = env.rt.agent(s.id);
    for (let i = 0; i < 4; i++) await agent.run(`list files ${i}`);
    inject('kronos', {
      id: 'kronos',
      async chat(): Promise<ChatResponse> {
        throw new ProviderError('provider is down', 'kronos', 400, false);
      },
    } as Provider);
    const notices: string[] = [];
    const off = env.rt.events.on((e) => {
      const ev = (e as { event?: { type: string; text?: string } }).event;
      if (ev?.type === 'notice' && ev.text) notices.push(ev.text);
    });
    const model: ModelInfo = { ...env.rt.providers.resolve(), contextWindow: 200 };
    await internals(agent).maybeCompact(model, 'r_test', new AbortController().signal);
    off();
    const live = env.rt.sessions.messages(s.id);
    expect(messageText(live[0] as Message)).toMatch(/could not be made \(provider is down\)/);
    expect(userTexts(live)).toEqual(['list files 2', 'list files 3']);
    expect(env.rt.sessions.archivedMessages(s.id).length).toBeGreaterThan(0);
    expect(notices.some((n) => /could not be summarized/.test(n))).toBe(true);
  });

  it('summarizes very long histories in bounded chunks', () => {
    const agent = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    const msgs: Message[] = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: 'user', parts: [{ type: 'text', text: `${i} ${'y'.repeat(300)}` }], createdAt: i }));
    const chunks: string[] = internals(agent).transcriptChunks(msgs, 1000);
    expect(chunks).toHaveLength(8); // first chunk + the 7 most recent
    expect(chunks[0]).toMatch(/^USER: 0 /);
    expect(chunks.at(-1)).toMatch(/USER: 39 /);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
  });
});

describe('syntax check after edits', () => {
  it('finds parse errors in the common file types', async () => {
    const ws = env.workspace;
    expect(await syntaxProblems(join(ws, 'a.ts'), 'const x: number = 1;\n', ws)).toEqual([]);
    const ts = await syntaxProblems(join(ws, 'a.ts'), 'function f() {\n  return {;\n}\n', ws);
    expect(ts[0]).toMatchObject({ line: 2 });
    expect((await syntaxProblems(join(ws, 'a.tsx'), 'const a = <div>{1}</div>;\n', ws))).toEqual([]);
    expect((await syntaxProblems(join(ws, 'a.json'), '{"a": 1,}', ws))[0]?.line).toBe(1);
    expect(await syntaxProblems(join(ws, 'tsconfig.json'), '{ // comments are fine here\n}', ws)).toEqual([]);
    expect((await syntaxProblems(join(ws, 'a.yaml'), 'a: [1, 2\nb: 3\n', ws)).length).toBeGreaterThan(0);
    expect(await syntaxProblems(join(ws, 'a.md'), '{{{', ws)).toEqual([]);
  });

  it('reports a broken edit in the tool result itself', async () => {
    let step = 0;
    inject('kronos', {
      id: 'kronos',
      async chat(): Promise<ChatResponse> {
        step++;
        if (step === 1) {
          const call: ToolCallPart = { type: 'tool_call', id: 'call_1', name: 'write_file', input: { path: 'bad.ts', content: 'export function f() {\n  return [1, 2;\n}\n' } };
          return { parts: [call], stopReason: 'tool_use', usage, model: 'scripted' };
        }
        return { parts: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);
    const s = env.rt.createSession({ source: 'test' });
    await env.rt.agent(s.id).run('write bad.ts');
    const result = env.rt.sessions
      .messages(s.id)
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result') as { content: string; meta?: { syntaxErrors?: number } };
    expect(result.content).toMatch(/Syntax check failed/);
    expect(result.content).toMatch(/bad\.ts:2:\d+/);
    expect(result.meta?.syntaxErrors).toBeGreaterThan(0);
  });
});

describe('stale-write guard', () => {
  it('will not overwrite a file it never read, or one that changed since it read it — once', async () => {
    const s = env.rt.createSession({ source: 'test' });
    const agent = env.rt.agent(s.id);
    const ctx = { runtime: env.rt, agent, sessionId: s.id, cwd: env.workspace, signal: new AbortController().signal, toolCallId: 't', turn: 0, progress() {}, askUser: async () => '', checkpoint() {} } as never;
    const tools = env.rt.tools;
    const write = (content: string) => tools.get('write_file')!.execute({ path: 'notes.md', content }, ctx);
    writeFileSync(join(env.workspace, 'notes.md'), 'the user wrote this\n');

    let r = await write('mine\n');
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/have not read it/);
    expect(readFileSync(join(env.workspace, 'notes.md'), 'utf8')).toBe('the user wrote this\n');

    await tools.get('read_file')!.execute({ path: 'notes.md' }, ctx);
    expect((await write('mine\n')).isError).toBeFalsy();
    // its own write keeps it current
    expect((await write('mine again\n')).isError).toBeFalsy();

    // someone else edits the file
    await new Promise((res) => setTimeout(res, 20));
    writeFileSync(join(env.workspace, 'notes.md'), 'edited meanwhile by the user\n');
    r = await write('stale\n');
    expect(r.content).toMatch(/changed on disk since you last read it/);
    expect(readFileSync(join(env.workspace, 'notes.md'), 'utf8')).toBe('edited meanwhile by the user\n');
    // a deliberate second attempt goes through; new files are never blocked
    expect((await write('overwrite on purpose\n')).isError).toBeFalsy();
    expect((await tools.get('write_file')!.execute({ path: 'fresh.md', content: 'x' }, ctx)).isError).toBeFalsy();
  });
});

describe('guardian in unattended runs', () => {
  it('lets a safety reviewer refuse a dangerous action nobody can approve', async () => {
    const reviewed: string[] = [];
    let step = 0;
    inject('kronos', {
      id: 'kronos',
      async chat(req): Promise<ChatResponse> {
        if (req.system.startsWith('You review one action')) {
          reviewed.push(JSON.stringify(req.messages));
          return { parts: [{ type: 'text', text: '{"risk_level":"high","user_authorization":"unknown","outcome":"deny","rationale":"force-pushing was never requested"}' }], stopReason: 'end_turn', usage, model: 'scripted' };
        }
        if (!req.tools.length) return { parts: [{ type: 'text', text: 'title' }], stopReason: 'end_turn', usage, model: 'scripted' };
        step++;
        if (step === 1) return { parts: [{ type: 'tool_call', id: 'c1', name: 'shell', input: { command: 'git push --force origin main' } } as ToolCallPart], stopReason: 'tool_use', usage, model: 'scripted' };
        return { parts: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);
    const r = await env.rt.runHeadless('summarise the README', { autoApprove: true, mode: 'yolo', model: 'kronos:demo' });
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toContain('summarise the README');
    expect(reviewed[0]).toContain('git push --force origin main');
    const result = env.rt.sessions.messages(r.sessionId).flatMap((m) => m.parts).find((p) => p.type === 'tool_result') as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/safety reviewer refused it \(high risk\): force-pushing was never requested/);
  });
});

describe('long commands', () => {
  it('moves a command past its timeout to the background instead of killing it', async () => {
    const s = env.rt.createSession({ source: 'test' });
    const agent = env.rt.agent(s.id);
    const ctx = { runtime: env.rt, agent, sessionId: s.id, cwd: env.workspace, signal: new AbortController().signal, toolCallId: 't', turn: 0, progress() {}, askUser: async () => '', checkpoint() {} } as never;
    const r = await env.rt.tools.get('shell')!.execute({ command: 'echo started; sleep 2; echo finished > done.txt; echo finished', timeout: 1 }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/^started\n\[still running after 1s — it keeps running in the background as p_\w+/);
    const id = (r.meta as { processId: string }).processId;
    for (let i = 0; i < 60 && env.rt.processes.list().find((p) => p.id === id)?.running; i++) await new Promise((res) => setTimeout(res, 100));
    expect(env.rt.processes.list().find((p) => p.id === id)).toMatchObject({ running: false, exitCode: 0 });
    expect(env.rt.processes.output(id)).toContain('finished');
    expect(readFileSync(join(env.workspace, 'done.txt'), 'utf8')).toBe('finished\n');
  });
});

describe('tool_search', () => {
  it('keeps a large MCP tool set out of the request and loads what the model asks for', async () => {
    const calls: string[] = [];
    for (let i = 0; i < 40; i++) {
      const what = i === 7 ? 'Create an issue in the Jira project' : `Unrelated operation number ${i} on widgets`;
      env.rt.tools.register({ name: `mcp__corp__op_${i}`, toolset: 'mcp', risk: 'read', description: `[MCP corp] ${what}`, parameters: { type: 'object', properties: { title: { type: 'string' } } }, async execute(input) { calls.push(`op_${i}:${String(input.title)}`); return { content: 'created JIRA-1' }; } });
    }
    const seen: string[][] = [];
    let step = 0;
    inject('kronos', {
      id: 'kronos',
      async chat(req): Promise<ChatResponse> {
        if (!req.tools.length) return { parts: [{ type: 'text', text: 'title' }], stopReason: 'end_turn', usage, model: 'scripted' };
        seen.push(req.tools.map((t) => t.name));
        step++;
        const call = (name: string, input: Record<string, unknown>): ChatResponse => ({ parts: [{ type: 'tool_call', id: `c${step}`, name, input } as ToolCallPart], stopReason: 'tool_use', usage, model: 'scripted' });
        if (step === 1) return call('tool_search', { query: 'jira issue', limit: 2 });
        if (step === 2) return call('mcp__corp__op_7', { title: 'Broken login' });
        return { parts: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);
    const s = env.rt.createSession({ source: 'test' });
    await env.rt.agent(s.id).run('file a jira issue about the broken login');
    expect(seen[0]).toContain('tool_search');
    expect(seen[0]!.filter((n) => n.startsWith('mcp__'))).toEqual([]);
    expect(seen[1]).toContain('mcp__corp__op_7');
    expect(calls).toEqual(['op_7:Broken login']);
    // the loaded tool stays available in this session
    expect(env.rt.sessions.get(s.id)?.meta?.loadedTools).toContain('mcp__corp__op_7');
    env.rt.tools.unregisterWhere((d) => d.name.startsWith('mcp__corp__'));
  });
});

describe('recaps of past work', () => {
  it('writes a task history per idle conversation and an index that new conversations see', async () => {
    const prompts: string[] = [];
    env.rt.updateConfig({ memory: { recaps: true } } as never); // before inject: a config change rebuilds the providers
    inject('kronos', {
      id: 'kronos',
      async chat(req): Promise<ChatResponse> {
        if (req.system.startsWith('You are part of an agent')) {
          prompts.push(messageText(req.messages[0]!));
          return { parts: [{ type: 'text', text: '{"summary": "## Migrate auth to OAuth\\n- user asked to migrate src/auth.ts; token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\\n- done: login works; open: refresh tokens", "slug": "oauth-migration"}' }], stopReason: 'end_turn', usage, model: 'scripted' };
        }
        if (req.system.startsWith('Consolidate')) return { parts: [{ type: 'text', text: '## User profile\nDeveloper of acme.\n## User preferences\n(none)\n## Past work\n### acme\n`2026-10-20-oauth-migration.md` — OAuth migration, refresh tokens open' }], stopReason: 'end_turn', usage, model: 'scripted' };
        return { parts: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);
    const s = env.rt.createSession({ source: 'cli', title: 'OAuth' });
    const agent = env.rt.agent(s.id);
    await agent.run('migrate src/auth.ts to OAuth');
    await agent.run('now add refresh tokens');
    const old = new Date('2026-10-20T10:00:00Z').getTime();
    env.rt.sessions.update(s.id, { updatedAt: old });
    expect(env.rt.recaps.eligible().map((x) => x.id)).toEqual([s.id]);
    const r = await env.rt.recaps.run();
    expect(r).toEqual({ recapped: ['2026-10-20-oauth-migration.md'], indexed: true });
    expect(prompts[0]).toContain('USER: migrate src/auth.ts to OAuth');
    const recap = readFileSync(join(env.rt.recaps.dir, '2026-10-20-oauth-migration.md'), 'utf8');
    expect(recap).toContain(`session: ${s.id}`);
    expect(recap).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789'); // secrets redacted
    // done once: nothing left until the conversation changes again
    expect(env.rt.recaps.eligible()).toEqual([]);
    // a new conversation starts knowing about the past work
    const next = env.rt.createSession({ source: 'cli' });
    await env.rt.agent(next.id).run('hi');
    expect(env.rt.sessions.get(next.id)?.systemPrompt).toContain('PAST WORK (index of earlier conversations)');
    expect(env.rt.sessions.get(next.id)?.systemPrompt).toContain('2026-10-20-oauth-migration.md');
  });
});

describe('permissionRequest hook', () => {
  it('can approve or refuse what would otherwise need a person', async () => {
    let step = 0;
    env.rt.updateConfig({ hooks: { permissionRequest: [{ matcher: 'shell', command: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.input.command.includes('deploy')){console.error('no deploys from automation');process.exit(2)}console.log(JSON.stringify({decision:'allow'}))})"` }] } } as never);
    inject('kronos', {
      id: 'kronos',
      async chat(req): Promise<ChatResponse> {
        if (!req.tools.length) return { parts: [{ type: 'text', text: 'title' }], stopReason: 'end_turn', usage, model: 'scripted' };
        step++;
        const call = (command: string): ChatResponse => ({ parts: [{ type: 'tool_call', id: `c${step}`, name: 'shell', input: { command } } as ToolCallPart], stopReason: 'tool_use', usage, model: 'scripted' });
        if (step === 1) return call('echo built > out.txt');
        if (step === 2) return call('./deploy.sh');
        return { parts: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);
    // Ask mode and nobody to ask: without the hook both commands would be refused
    const r = await env.rt.runHeadless('build and deploy', { mode: 'ask', model: 'kronos:demo' });
    const results = env.rt.sessions.messages(r.sessionId).flatMap((m) => m.parts).filter((p) => p.type === 'tool_result') as { content: string; isError?: boolean }[];
    expect(results[0]?.isError).toBeFalsy();
    expect(readFileSync(join(env.workspace, 'out.txt'), 'utf8')).toBe('built\n');
    expect(results[1]?.content).toMatch(/Refused by a permissionRequest hook: no deploys from automation/);
  });
});

describe('background agents', () => {
  it('run while the parent keeps working, and their reports are collected with wait', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    inject('kronos', {
      id: 'kronos',
      async chat(req): Promise<ChatResponse> {
        if (!req.tools.length) return { parts: [{ type: 'text', text: 'title' }], stopReason: 'end_turn', usage, model: 'scripted' };
        const sub = req.system.includes('You are a subagent');
        const done = req.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result').length;
        const call = (name: string, input: Record<string, unknown>): ChatResponse => ({ parts: [{ type: 'tool_call', id: `p${done}`, name, input } as ToolCallPart], stopReason: 'tool_use', usage, model: 'scripted' });
        if (sub) {
          await gate; // the subagent is slow
          order.push('sub finished');
          return { parts: [{ type: 'text', text: 'Found 3 TODOs in src/.' }], stopReason: 'end_turn', usage, model: 'scripted' };
        }
        if (done === 0) return call('agents', { action: 'spawn', task: 'Count TODOs in src/', label: 'todo counter' });
        if (done === 1) {
          order.push('parent kept working');
          release();
          return call('list_dir', { path: '.' });
        }
        // finishing without collecting the report gets a reminder first
        const reminded = req.messages.some((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('have results you have not collected')));
        if (done === 2 && !reminded) return { parts: [{ type: 'text', text: 'All done.' }], stopReason: 'end_turn', usage, model: 'scripted' };
        if (done === 2) return call('agents', { action: 'wait' });
        return { parts: [{ type: 'text', text: 'The helper found 3 TODOs.' }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);
    const s = env.rt.createSession({ source: 'test' });
    const r = await env.rt.agent(s.id).run('count todos in the background and list files meanwhile');
    expect(order).toEqual(['parent kept working', 'sub finished']);
    expect(r.text).toBe('The helper found 3 TODOs.');
    const results = env.rt.sessions.messages(s.id).flatMap((m) => m.parts).filter((p) => p.type === 'tool_result') as { toolName: string; content: string }[];
    expect(results[0]?.content).toMatch(/^Started a1 \(todo counter\) in the background/);
    expect(results.find((p) => p.toolName === 'agents' && p.content.includes('## a1'))?.content).toMatch(/## a1 todo counter — done\nFound 3 TODOs in src\//);
  });
});

describe('structured output', () => {
  const schema = { type: 'object', properties: { files: { type: 'integer' }, names: { type: 'array', items: { type: 'string' } } }, required: ['files', 'names'] };
  it('parses and checks a JSON answer', () => {
    expect(parseStructured('```json\n{"files": 2, "names": ["a", "b"]}\n```', schema)).toEqual({ ok: true, value: { files: 2, names: ['a', 'b'] }, errors: [] });
    expect(parseStructured('Here: {"files": 2}', schema).ok).toBe(false);
    expect(parseStructured('two files', schema).errors).toEqual(['the answer is not valid JSON']);
  });

  it('asks again until the final answer matches the schema', async () => {
    let n = 0;
    inject('kronos', {
      id: 'kronos',
      async chat(req): Promise<ChatResponse> {
        if (!req.tools.length) return { parts: [{ type: 'text', text: 'title' }], stopReason: 'end_turn', usage, model: 'scripted' };
        n++;
        const text = n === 1 ? 'There are two files: a and b.' : '{"files": 2, "names": ["a", "b"]}';
        return { parts: [{ type: 'text', text }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);
    const r = (await env.rt.runHeadless('count the files', { model: 'kronos:demo', outputSchema: schema })) as { output?: unknown; schemaErrors?: string[] };
    expect(n).toBe(2);
    expect(r.output).toEqual({ files: 2, names: ['a', 'b'] });
    expect(r.schemaErrors).toBeUndefined();
  });
});

describe('learning review', () => {
  it('updates memory in the background after a correction, without touching the conversation', async () => {
    inject('kronos', {
      id: 'kronos',
      async chat(req): Promise<ChatResponse> {
        if (!req.tools.length) return { parts: [{ type: 'text', text: 'title' }], stopReason: 'end_turn', usage, model: 'scripted' };
        if (req.system.includes('You maintain the memory and skill library')) {
          const done = req.messages.flatMap((m) => m.parts).some((p) => p.type === 'tool_result');
          if (!done) return { parts: [{ type: 'tool_call', id: 'm1', name: 'memory', input: { action: 'add', target: 'user', content: 'Wants answers without bullet lists.' } } as ToolCallPart], stopReason: 'tool_use', usage, model: 'scripted' };
          return { parts: [{ type: 'text', text: 'Saved.' }], stopReason: 'end_turn', usage, model: 'scripted' };
        }
        return { parts: [{ type: 'text', text: 'Understood.' }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);
    const s = env.rt.createSession({ source: 'test' });
    await env.rt.agent(s.id).run("don't answer with bullet lists, I prefer prose");
    for (let i = 0; i < 50 && !env.rt.memory.entries('user').length; i++) await new Promise((r) => setTimeout(r, 50));
    expect(env.rt.memory.entries('user')).toEqual(['Wants answers without bullet lists.']);
    // the main conversation has no reminder notes in it
    expect(env.rt.sessions.messages(s.id).some((m) => m.role === 'system')).toBe(false);
  });
});

describe('persistent kernels', () => {
  it('keep Python and JavaScript state between calls, and reset or die cleanly', async () => {
    const s = env.rt.createSession({ source: 'test' });
    const ctx = { runtime: env.rt, agent: env.rt.agent(s.id), sessionId: s.id, cwd: env.workspace, signal: new AbortController().signal, toolCallId: 't', turn: 0, progress() {}, askUser: async () => '', checkpoint() {} } as never;
    const run = (language: string, code: string, extra: Record<string, unknown> = {}) => env.rt.tools.get('execute_code')!.execute({ language, code, persistent: true, ...extra }, ctx);
    let r = await run('python', 'import math\nrows = [1, 2, 3]\nprint("loaded")');
    expect(r.content).toMatch(/^\[python kernel · cell 1 · new kernel/);
    expect(r.content).toContain('loaded');
    r = await run('python', 'sum(rows) * math.pi');
    expect(r.content).toMatch(/cell 2\]\nOut: 18\.84955592153876/);
    r = await run('python', '1/0');
    expect(r.isError).toBe(true);
    expect(r.content).toContain('ZeroDivisionError');
    expect((await run('python', 'len(rows)')).content).toContain('Out: 3'); // an error does not lose state
    expect((await run('python', 'rows', { reset: true })).content).toMatch(/new kernel[\s\S]*NameError/);
    r = await run('python', 'import time\ntime.sleep(5)', { timeout: 1 });
    expect(r.content).toMatch(/timed out after 1s — its state is gone/);
    expect((await run('python', 'print("back")')).content).toMatch(/new kernel[\s\S]*back/);
    await run('javascript', 'const seen = new Set([1, 2]); console.log("js up")');
    r = await run('javascript', 'seen.add(3); await new Promise((r) => setTimeout(r, 10)); return seen.size');
    expect(r.content).toMatch(/cell 2\]\nOut: 3/);
    env.rt.kernels.stopSession(s.id);
  }, 30_000);
});

describe('context references', () => {
  it('expands @diff, @staged and @git:<rev> into attached text', async () => {
    const { execFileSync } = await import('node:child_process');
    const git = (...a: string[]) => execFileSync('git', a, { cwd: env.workspace, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(env.workspace, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'first commit');
    writeFileSync(join(env.workspace, 'a.txt'), 'two\n');
    const input = await env.rt.expandInput('explain @diff and @git:HEAD please', env.workspace);
    const names = (input.files ?? []).map((f) => f.name);
    expect(names).toEqual(['@diff', '@git:HEAD']);
    expect(input.files?.[0]?.text).toContain('+two');
    expect(input.files?.[1]?.text).toContain('first commit');
    expect((await env.rt.expandInput('@staged', env.workspace)).files?.[0]?.text).toBe('(nothing staged)');
    expect((await env.rt.expandInput('@git:$(rm)', env.workspace)).files?.[0]?.text).toMatch(/could not load/);
  });
});
