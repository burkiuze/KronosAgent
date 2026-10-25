import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Kronos, ProviderError, evalConfigs, messageText, parseEvalSuite, runEvalSuite } from '@kronos/core';
import type { ChatRequest, ChatResponse, Message, Provider, StreamEvent, ToolCallPart } from '@kronos/core';
import { LoopWatch } from '../src/agent/watchdog.js';
import { overBudget } from '../src/agent/agent.js';
import { makeRuntime, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await makeRuntime();
});
afterEach(async () => {
  await env.cleanup();
});

const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A provider that always answers with the same tool call — a model stuck in a loop. */
function loopingProvider(call: () => { name: string; input: Record<string, unknown> }): Provider {
  let n = 0;
  return {
    id: 'kronos',
    async chat(): Promise<ChatResponse> {
      const c = call();
      const part: ToolCallPart = { type: 'tool_call', id: `call_${++n}`, name: c.name, input: c.input };
      return { parts: [{ type: 'text', text: `attempt ${n}` }, part], stopReason: 'tool_use', usage, model: 'loop' };
    },
  } as Provider;
}

function inject(rt: Kronos, id: string, provider: Provider): void {
  (rt.providers as unknown as { cache: Map<string, Provider> }).cache.set(id, provider);
}

describe('loop watchdog', () => {
  it('warns on repeated failures and repeated identical reads, then stops', () => {
    const w = new LoopWatch();
    const fail = { name: 'read_file', input: { path: 'nope.md' }, isError: true, content: 'File not found: nope.md' };
    expect(w.observe([fail]).kind).toBe('ok');
    expect(w.observe([fail]).kind).toBe('ok');
    const third = w.observe([fail]);
    expect(third.kind).toBe('warn');
    expect(third.kind === 'warn' && third.note).toMatch(/failed 3 times.*File not found/);
    expect(w.observe([fail]).kind).toBe('ok'); // warned once
    w.observe([fail]);
    const sixth = w.observe([fail]);
    expect(sixth.kind).toBe('stop');

    const w2 = new LoopWatch();
    const ls = { name: 'list_dir', input: { path: '.' }, isError: false, content: 'a\nb' };
    for (let i = 0; i < 3; i++) expect(w2.observe([ls]).kind).toBe('ok');
    expect(w2.observe([ls]).kind).toBe('warn');
    // re-running checks or commands is normal and never flagged
    const shell = { name: 'shell', input: { command: 'npm test' }, isError: false, content: 'ok' };
    for (let i = 0; i < 8; i++) expect(w2.observe([shell]).kind).toBe('ok');
  });

  it('ends a run that keeps repeating a failing action', async () => {
    inject(env.rt, 'kronos', loopingProvider(() => ({ name: 'read_file', input: { path: 'missing.md' } })));
    const a = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    const res = await a.run('do it');
    expect(res.stopReason).toBe('stalled');
    expect(res.toolCalls).toBe(6);
    const notes = env.rt.sessions.messages(a.id).filter((m) => m.meta?.kind === 'note' && messageText(m).includes('has now failed 3 times'));
    expect(notes).toHaveLength(1);
  });
});

describe('run budget', () => {
  it('describes which limit was reached', () => {
    const u = { ...usage, costUsd: 0.5 };
    expect(overBudget({ maxTokens: 0, maxCostUsd: 0, maxMinutes: 0 }, u, Date.now())).toBe('');
    expect(overBudget({ maxTokens: 120, maxCostUsd: 0, maxMinutes: 0 }, u, Date.now())).toMatch(/150 of 120 tokens/);
    expect(overBudget({ maxTokens: 0, maxCostUsd: 0.25, maxMinutes: 0 }, u, Date.now())).toBe('$0.50 of $0.25');
    expect(overBudget({ maxTokens: 0, maxCostUsd: 0, maxMinutes: 1 }, u, Date.now() - 61_000)).toBe('1 min');
  });

  it('stops a run cleanly when it reaches the token budget', async () => {
    let i = 0;
    env.rt.updateConfig({ agent: { budget: { maxTokens: 400, maxCostUsd: 0, maxMinutes: 0 } } });
    // after updateConfig: it rebuilds provider clients
    inject(env.rt, 'kronos', loopingProvider(() => ({ name: 'list_dir', input: { path: `.${'/.'.repeat(i++)}` } })));
    const a = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    const res = await a.run('keep going');
    expect(res.stopReason).toBe('budget');
    expect(res.toolCalls).toBe(3); // 150 tokens per turn: stops before the 4th call
    expect(res.text).toBe('attempt 3');
  });
});

describe('unchanged file reads', () => {
  it('points back to the earlier read instead of returning the file again', async () => {
    writeFileSync(join(env.workspace, 'notes.md'), '# Notes\n\nsecret sauce\n');
    const a = env.rt.agent(env.rt.createSession({ source: 'test' }).id);
    const reads = () => env.rt.sessions.messages(a.id).flatMap((m) => m.parts).filter((p) => p.type === 'tool_result' && p.toolName === 'read_file') as { content: string }[];
    await a.run('read notes.md');
    await a.run('read notes.md');
    expect(reads()[0]?.content).toContain('secret sauce');
    expect(reads()[1]?.content).toMatch(/has not changed since you read it/);
    // a changed file is read in full again
    writeFileSync(join(env.workspace, 'notes.md'), '# Notes\n\nnew recipe, longer\n');
    await a.run('read notes.md');
    expect(reads()[2]?.content).toContain('new recipe');
    // after compaction the earlier output is gone from context, so it is read in full too
    await a.compact();
    await a.run('read notes.md');
    expect(reads().at(-1)?.content).toContain('new recipe');
  });
});

describe('provider resilience', () => {
  const req = (rt: Kronos): ChatRequest => ({ model: rt.providers.resolve('openai:gpt-test'), system: '', messages: [] as Message[], tools: [], maxTokens: 50 }) as ChatRequest;

  it('discards a half-streamed attempt before retrying', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    let calls = 0;
    inject(env.rt, 'openai', {
      id: 'openai',
      async chat(_r: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResponse> {
        calls++;
        onEvent({ type: 'text', text: calls === 1 ? 'Hel' : 'Hello' });
        if (calls === 1) throw Object.assign(new ProviderError('overloaded', 'openai', 529, true), { retryAfterMs: 1 });
        return { parts: [{ type: 'text', text: 'Hello' }], stopReason: 'end_turn', usage, model: 'gpt-test' };
      },
    } as Provider);
    const seen: string[] = [];
    await env.rt.providers.chat(req(env.rt), (e) => seen.push(e.type === 'text' ? `text:${e.text}` : e.type), []);
    expect(seen).toEqual(['text:Hel', 'notice', 'restart', 'text:Hello']);
    delete process.env.OPENAI_API_KEY;
  });

  it('skips a provider that keeps failing while a fallback is available', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    let attempts = 0;
    inject(env.rt, 'openai', {
      id: 'openai',
      async chat(): Promise<ChatResponse> {
        attempts++;
        throw Object.assign(new ProviderError('upstream down', 'openai', 503, true), { retryAfterMs: 1 });
      },
    } as Provider);
    const notices: string[] = [];
    const ask = () => env.rt.providers.chat(req(env.rt), (e) => e.type === 'notice' && notices.push(e.text), ['kronos:demo']);
    for (let i = 0; i < 3; i++) expect((await ask()).modelInfo.ref).toBe('kronos:demo');
    const before = attempts;
    expect((await ask()).modelInfo.ref).toBe('kronos:demo');
    expect(attempts).toBe(before); // breaker open: not even tried
    expect(notices.some((n) => /Skipping .*failed repeatedly/.test(n))).toBe(true);
    expect(Object.keys(env.rt.providers.breakerStatus())).toEqual(['openai']);
    delete process.env.OPENAI_API_KEY;
  });
});

describe('eval trajectories', () => {
  it('hands every run’s full message history to the caller', async () => {
    const suite = parseEvalSuite('repeats: 1\ncases:\n  - name: ls\n    prompt: list the files here\n    checks:\n      - max_tool_calls: 5\n');
    const got: Message[][] = [];
    await runEvalSuite(suite, evalConfigs(suite, { model: 'kronos:demo', effort: 'medium' }), {
      createRuntime: (cfg, home) => Kronos.create({ home, cwd: home, connectMcp: false, logLevel: 'silent', overrides: { model: { default: cfg.model }, skills: { claudeCompat: false } } }),
      onTrajectory: (_r, messages) => got.push(messages),
    });
    expect(got).toHaveLength(1);
    expect(got[0]!.some((m) => m.parts.some((p) => p.type === 'tool_call' && p.name === 'list_dir'))).toBe(true);
  });
});

describe('no demo fallback', () => {
  // a fresh install: model "auto", no keys anywhere
  let fresh: TestEnv;
  beforeEach(async () => {
    fresh = await makeRuntime({ model: { default: 'auto' } });
  });
  afterEach(async () => {
    delete process.env.OPENAI_API_KEY;
    await fresh.cleanup();
  });

  it('needs a connected provider unless the demo model was chosen explicitly', () => {
    expect(env.rt.providers.readiness()).toEqual({ ok: true }); // test runtimes pick kronos:demo on purpose
    expect(fresh.rt.providers.readiness()).toEqual({ ok: false, reason: 'no_provider' });
    expect(fresh.rt.providers.readiness('demo')).toEqual({ ok: true });
    expect(fresh.rt.providers.readiness('openai:gpt-5.5')).toEqual({ ok: false, reason: 'missing_key', provider: 'openai' });
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(fresh.rt.providers.readiness()).toEqual({ ok: true });
  });

  it('keeps the message, says "connect a provider", and answers it once one is connected', async () => {
    const s = fresh.rt.createSession({ source: 'test' });
    const notices: unknown[] = [];
    const off = fresh.rt.events.on((e) => (e as { event?: { type: string } }).event?.type === 'notice' && notices.push((e as { event: unknown }).event));
    const agent = fresh.rt.agent(s.id);
    const res = await agent.run('hello');
    off();
    expect(res.stopReason).toBe('error');
    expect(res.error).toMatch(/No model provider is connected/);
    expect(notices).toEqual([expect.objectContaining({ level: 'error', code: 'no_provider' })]);
    const held = fresh.rt.sessions.messages(s.id);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ role: 'user', meta: { unanswered: 'no_provider' } });
    // still nothing connected: answering again keeps the single held message
    expect((await agent.answerHeld())?.error).toMatch(/No model provider/);
    expect(fresh.rt.sessions.messages(s.id)).toHaveLength(1);

    process.env.OPENAI_API_KEY = 'sk-test';
    inject(fresh.rt, 'openai', {
      id: 'openai',
      async chat(): Promise<ChatResponse> {
        return { parts: [{ type: 'text', text: 'real answer' }], stopReason: 'end_turn', usage, model: 'gpt' };
      },
    } as Provider);
    expect((await agent.answerHeld())?.text).toBe('real answer');
    const after = fresh.rt.sessions.messages(s.id).filter((m) => m.role !== 'system');
    expect(after.map((m) => [m.role, messageText(m)])).toEqual([['user', 'hello'], ['assistant', 'real answer']]);
    expect(after[0]?.meta?.unanswered).toBeUndefined();
    expect(agent.heldMessage()).toBeUndefined();
  });

  it('refuses headless runs before creating a session', async () => {
    const before = fresh.rt.sessions.list({ includeChildren: true }).length;
    const headless = await fresh.rt.runHeadless('hello', { source: 'api' });
    expect(headless.error).toMatch(/No model provider is connected/);
    expect(fresh.rt.sessions.list({ includeChildren: true }).length).toBe(before);
  });

  it('moves a chat that was pinned to the demo model onto a provider connected later', async () => {
    const s = fresh.rt.createSession({ source: 'test', model: 'kronos:demo' });
    process.env.OPENAI_API_KEY = 'sk-test';
    inject(fresh.rt, 'openai', {
      id: 'openai',
      async chat(): Promise<ChatResponse> {
        return { parts: [{ type: 'text', text: 'real answer' }], stopReason: 'end_turn', usage, model: 'gpt' };
      },
    } as Provider);
    const res = await fresh.rt.agent(s.id).run('hello');
    expect(res.text).toBe('real answer');
    expect(fresh.rt.sessions.get(s.id)?.model.startsWith('openai:')).toBe(true);
  });
});
