import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EngineClient, runEngineTurn, ProviderRegistry, defaultConfig, type AgentEvent, type Message, type PermissionRequest } from '@kronos/core';

/**
 * A stand-in for the engine's server that replays the event sequence recorded from the real engine
 * for a turn with reasoning, text, a permission-gated bash call and a final answer.
 */
const SID = 'ses_test1';
const M1 = 'msg_a1';
const M2 = 'msg_a2';

function script(permissionReply: string): Record<string, unknown>[] {
  const part = (p: Record<string, unknown>) => ({ type: 'message.part.updated', properties: { sessionID: SID, part: { sessionID: SID, ...p }, time: 1 } });
  const delta = (messageID: string, partID: string, d: string) => ({ type: 'message.part.delta', properties: { sessionID: SID, messageID, partID, field: 'text', delta: d } });
  const ok = permissionReply !== 'reject';
  return [
    { type: 'message.updated', properties: { sessionID: SID, info: { id: 'msg_u1', sessionID: SID, role: 'user' } } },
    part({ id: 'prt_u', messageID: 'msg_u1', type: 'text', text: 'run it' }),
    { type: 'session.status', properties: { sessionID: SID, status: { type: 'busy' } } },
    { type: 'message.updated', properties: { sessionID: SID, info: { id: M1, sessionID: SID, role: 'assistant' } } },
    part({ id: 'prt_r', messageID: M1, type: 'reasoning', text: '' }),
    delta(M1, 'prt_r', 'Need a command. '),
    part({ id: 'prt_t1', messageID: M1, type: 'text', text: '' }),
    delta(M1, 'prt_t1', 'On it.'),
    part({ id: 'prt_tool', messageID: M1, type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'pending', input: {} } }),
    { type: 'permission.asked', properties: { id: 'per_1', sessionID: SID, permission: 'bash', patterns: ['echo hi'], metadata: { command: 'echo hi' }, always: ['echo *'], tool: { messageID: M1, callID: 'call_1' } } },
    'WAIT_PERMISSION',
    part({ id: 'prt_tool', messageID: M1, type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'running', input: { command: 'echo hi' }, time: { start: 100 } } }),
    ok
      ? part({ id: 'prt_tool', messageID: M1, type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi\n', title: 'echo hi', metadata: {}, time: { start: 100, end: 150 } } })
      : part({ id: 'prt_tool', messageID: M1, type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'error', input: { command: 'echo hi' }, error: 'The user rejected permission', time: { start: 100, end: 101 } } }),
    part({ id: 'prt_sf1', messageID: M1, type: 'step-finish', tokens: { input: 40, output: 10, reasoning: 2, cache: { read: 5, write: 0 } }, cost: 0 }),
    { type: 'message.updated', properties: { sessionID: SID, info: { id: M2, sessionID: SID, role: 'assistant' } } },
    part({ id: 'prt_t2', messageID: M2, type: 'text', text: '' }),
    delta(M2, 'prt_t2', 'Done: '),
    delta(M2, 'prt_t2', 'hi'),
    part({ id: 'prt_t2', messageID: M2, type: 'text', text: 'Done: hi' }),
    part({ id: 'prt_sf2', messageID: M2, type: 'step-finish', tokens: { input: 50, output: 12, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }),
    { type: 'session.idle', properties: { sessionID: SID } },
  ];
}

let server: Server;
let base: string;
let permissionReplies: { id: string; reply: string; message?: string }[] = [];
let prompts: Record<string, unknown>[] = [];
let sessionsCreated = 0;
let nextReply = 'once';

beforeAll(async () => {
  // the permission reply can arrive before the replay reaches its wait point: remember it
  let release: (() => void) | undefined;
  let permitted = false;
  const streams: ((e: unknown) => void)[] = [];
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(v === undefined ? '' : JSON.stringify(v));
      };
      if (url.pathname === '/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
        streams.push((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
        return;
      }
      if (url.pathname === '/session' && req.method === 'POST') {
        sessionsCreated += 1;
        return json(200, { id: SID });
      }
      if (url.pathname === `/session/${SID}` && req.method === 'GET') return json(200, { id: SID, title: 'Run a command' });
      if (url.pathname === `/session/${SID}/prompt_async`) {
        prompts.push(JSON.parse(body));
        permitted = false;
        json(204, undefined);
        for (const e of script(nextReply)) {
          if (e === 'WAIT_PERMISSION') {
            if (!permitted) await new Promise<void>((r) => (release = r));
            continue;
          }
          for (const s of streams) s(e);
          await new Promise((r) => setTimeout(r, 2));
        }
        return;
      }
      if (url.pathname.startsWith('/permission/')) {
        permissionReplies.push({ id: url.pathname.split('/')[2]!, ...JSON.parse(body) });
        json(200, true);
        permitted = true;
        release?.();
        release = undefined;
        return;
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections?.();
  server.close();
});

async function turn(decision: 'allow' | 'deny', engineSessionId?: string) {
  permissionReplies = [];
  prompts = [];
  nextReply = decision === 'allow' ? 'once' : 'reject';
  const events: AgentEvent[] = [];
  const messages: Message[] = [];
  const asked: Omit<PermissionRequest, 'requestId' | 'sessionId'>[] = [];
  let mapped: string | undefined;
  const result = await runEngineTurn({
    client: new EngineClient(base, '/work'),
    runId: 'r1',
    modelRef: 'free:big-pickle',
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    contextWindow: 200_000,
    engineSessionId,
    onEngineSession: (id) => (mapped = id),
    text: 'run it',
    system: 'You are Kronos.',
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    onMessage: (m) => messages.push(m),
    askPermission: async (req) => {
      asked.push(req);
      return decision === 'allow' ? { decision: 'allow' } : { decision: 'deny', feedback: 'not now' };
    },
  });
  return { result, events, messages, asked, mapped };
}

describe('engine turn', () => {
  it('translates a full turn into Kronos events, messages and usage', async () => {
    const { result, events, messages, asked, mapped } = await turn('allow');
    expect(result.stopReason).toBe('end_turn');
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('Done: hi');
    expect(result.toolCalls).toBe(1);
    expect(result.usage.inputTokens).toBe(90);
    expect(result.usage.outputTokens).toBe(22);
    expect(result.engineTitle).toBe('Run a command');
    expect(mapped).toBe(SID);

    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')).toBe('On it.Done: hi');
    expect(events.filter((e) => e.type === 'thinking_delta').map((e) => (e as { text: string }).text).join('')).toBe('Need a command. ');
    const call = events.find((e) => e.type === 'tool_call') as Extract<AgentEvent, { type: 'tool_call' }>;
    expect(call).toMatchObject({ id: 'call_1', name: 'shell', input: { command: 'echo hi' }, toolset: 'shell' });
    const res = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(res).toMatchObject({ id: 'call_1', content: 'hi\n', isError: false, durationMs: 50 });
    // the user message is not echoed back as assistant output
    expect(events.some((e) => e.type === 'text_delta' && (e as { text: string }).text.includes('run it'))).toBe(false);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ toolName: 'shell', risk: 'execute', toolCallId: 'call_1' });
    expect(permissionReplies).toEqual([{ id: 'per_1', reply: 'once' }]);

    expect(messages.map((m) => `${m.role}:${m.parts.map((p) => p.type).join(',')}`)).toEqual(['assistant:thinking,text,tool_call', 'tool:tool_result', 'assistant:text']);
    expect(prompts[0]).toMatchObject({ model: { providerID: 'opencode', modelID: 'big-pickle' }, system: 'You are Kronos.', parts: [{ type: 'text', text: 'run it' }] });
  });

  it('passes a refusal and its reason back to the engine and reuses the engine session', async () => {
    const before = sessionsCreated;
    const { result, events, asked } = await turn('deny', SID);
    expect(sessionsCreated).toBe(before); // continued, not recreated
    expect(asked).toHaveLength(1);
    expect(permissionReplies).toEqual([{ id: 'per_1', reply: 'reject', message: 'not now' }]);
    const res = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(res.isError).toBe(true);
    expect(result.stopReason).toBe('end_turn');
  });
});

describe('engine models in the registry', () => {
  it('maps the hosted free models to "free" and other connected providers to their own groups', () => {
    const reg = new ProviderRegistry(defaultConfig());
    // before the engine reported its models, an engine ref stays on its provider and is not ready
    expect(reg.resolve('engine-anthropic:claude-sonnet-5-5').provider).toBe('engine-anthropic');
    expect(reg.readiness('engine-anthropic:claude-sonnet-5-5').ok).toBe(false);
    reg.setEngineModels([
      { providerID: 'opencode', providerName: 'OpenCode', id: 'big-pickle', name: 'Big Pickle', contextWindow: 200_000, maxOutput: 32_000, free: true, tools: true, vision: false, reasoning: true },
      { providerID: 'anthropic', providerName: 'Anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxOutput: 128_000, free: false, tools: true, vision: true, reasoning: true },
    ]);
    const free = reg.resolve('free:big-pickle');
    expect(free.name).toBe('Big Pickle');
    expect(reg.engineModelRef(free)).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
    const other = reg.resolve('engine-anthropic:claude-sonnet-5-5');
    expect(other.providerLabel).toBe('Anthropic');
    expect(reg.engineModelRef(other)).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5-5' });
    expect(reg.isConfigured('engine-anthropic')).toBe(true);
    // the engine groups never show in the keys UI
    expect(reg.statuses().some((s) => s.id.startsWith('engine-'))).toBe(false);
    // a native catalog model does not run on the engine
    expect(reg.engineModelRef(reg.resolve('anthropic:claude-opus-5-5'))).toBeUndefined();
  });
});
