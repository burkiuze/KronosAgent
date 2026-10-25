import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatProvider, ThinkSplitter, extractTextToolCalls, repairJson, resolveToolName, validateInput } from '@kronos/core';
import type { ChatRequest, ChatResponse, Message, Provider, StreamEvent, ToolCallPart } from '@kronos/core';
import { makeRuntime, type TestEnv } from './helpers.js';

/**
 * Everything a weak, old or free model gets wrong about tool calling, simulated: the harness has to
 * turn it into correct work anyway.
 */

const TOOLS = ['read_file', 'write_file', 'edit_file', 'shell', 'list_dir', 'grep', 'glob', 'todo_write', 'web_fetch'];

describe('JSON repair', () => {
  it.each([
    ['{"path": "a.ts",}', { path: 'a.ts' }],
    ["{'path': 'a.ts'}", { path: 'a.ts' }],
    ['{path: "a.ts", limit: 20}', { path: 'a.ts', limit: 20 }],
    ['{"background": True, "x": None}', { background: true, x: null }],
    ['{"content": "line1\nline2"}', { content: 'line1\nline2' }],
    ['```json\n{"path": "a.ts"}\n```', { path: 'a.ts' }],
    ['Sure! {"path": "a.ts"} hope this helps', { path: 'a.ts' }],
    ['{"command": "ls -la", "cwd": "src"', { command: 'ls -la', cwd: 'src' }],
    ["{'q': 'it\\'s fine'}", { q: "it's fine" }],
  ])('repairs %j', (raw, expected) => {
    expect(repairJson(raw)).toEqual(expected);
  });

  it('gives up on prose', () => {
    expect(repairJson('I cannot do that')).toBeUndefined();
  });
});

describe('tool names', () => {
  it.each([
    ['read_file', 'read_file'],
    ['ReadFile', 'read_file'],
    ['functions.read_file', 'read_file'],
    ['bash', 'shell'],
    ['run_command', 'shell'],
    ['str_replace', 'edit_file'],
    ['str_replace_editor', 'edit_file'],
    ['ls', 'list_dir'],
    ['cat', 'read_file'],
    ['raed_file', 'read_file'],
    ['launch_rockets', undefined],
  ])('%s → %s', (name, expected) => {
    expect(resolveToolName(name, TOOLS)).toBe(expected);
  });
});

describe('tool calls written as text', () => {
  const calls = (text: string, loose = false) => extractTextToolCalls(text, TOOLS, { loose });
  const one = (text: string, loose = false) => {
    const r = calls(text, loose);
    return r.calls.map((c) => [c.name, c.input]);
  };

  it('reads the common training formats', () => {
    expect(one('<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>')).toEqual([['read_file', { path: 'a.ts' }]]);
    expect(one('<function=shell>{"command": "ls"}</function>')).toEqual([['shell', { command: 'ls' }]]);
    expect(one('<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.ts\n</parameter>\n</function>\n</tool_call>')).toEqual([['read_file', { path: 'src/a.ts' }]]);
    expect(one('<|python_tag|>{"name": "grep", "parameters": {"pattern": "TODO"}}<|eom_id|>')).toEqual([['grep', { pattern: 'TODO' }]]);
    expect(one('[TOOL_CALLS][{"name": "list_dir", "arguments": {"path": "."}}]')).toEqual([['list_dir', { path: '.' }]]);
    expect(one('[TOOL_CALLS]shell[ARGS]{"command": "pwd"}')).toEqual([['shell', { command: 'pwd' }]]);
    expect(one('<invoke name="read_file"><parameter name="path">x.md</parameter></invoke>')).toEqual([['read_file', { path: 'x.md' }]]);
    expect(one('<read_file>\n<path>README.md</path>\n</read_file>')).toEqual([['read_file', { path: 'README.md' }]]);
    expect(one('```json\n{"tool": "bash", "args": {"command": "npm test"}}\n```')).toEqual([['shell', { command: 'npm test' }]]);
    expect(one('{"name": "cat", "arguments": "{\\"path\\": \\"a.ts\\"}"}')).toEqual([['read_file', { path: 'a.ts' }]]);
  });

  it('keeps the prose around a call and finds several calls', () => {
    const r = calls('I will look at both files.\n<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>\n<tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>');
    expect(r.text).toBe('I will look at both files.');
    expect(r.calls.map((c) => c.input.path)).toEqual(['a', 'b']);
  });

  it('accepts an unclosed block at the end of the reply', () => {
    expect(one('<tool_call>\n{"name": "shell", "arguments": {"command": "ls"}}')).toEqual([['shell', { command: 'ls' }]]);
  });

  it('leaves an example in a real answer alone unless the text protocol is on', () => {
    const answer = `To read a file with this agent you would send a call like the following. ${'Explanation continues here. '.repeat(20)}\n\`\`\`json\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n\`\`\`\nThat is all.`;
    expect(calls(answer).calls).toHaveLength(0);
    expect(calls(answer, true).calls).toHaveLength(1);
    expect(calls('Here is some data: {"name": "Ada", "age": 36}').calls).toHaveLength(0);
  });
});

describe('arguments under other names', () => {
  it('maps the names other agents use onto ours', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] };
    const v = validateInput(schema, { file_path: 'a.ts', old_str: 'x', newString: 'y' });
    expect(v.ok).toBe(true);
    expect(v.value).toEqual({ path: 'a.ts', old_string: 'x', new_string: 'y' });
    // a real argument always wins over an alias
    expect(validateInput(schema, { path: 'a.ts', file: 'b.ts', old_string: 'x', new_string: 'y' }).value.path).toBe('a.ts');
  });
});

describe('<think> in the answer text', () => {
  it('routes reasoning to thinking, even split across chunks', () => {
    const out: string[] = [];
    const s = new ThinkSplitter((kind, text) => out.push(`${kind}:${text}`));
    for (const chunk of ['<thi', 'nk>plan it', '</th', 'ink>\n\nThe answer', ' is 42. Use <think> tags']) s.push(chunk);
    s.flush();
    const text = out.filter((o) => o.startsWith('text:')).map((o) => o.slice(5)).join('');
    const thinking = out.filter((o) => o.startsWith('thinking:')).map((o) => o.slice(9)).join('');
    expect(thinking).toBe('plan it');
    expect(text).toBe('The answer is 42. Use <think> tags');
  });
});

describe('OpenAI-compatible model without native tool calling', () => {
  let server: Server;
  let bodies: Record<string, unknown>[];
  let reply: string;
  beforeEach(async () => {
    bodies = [];
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        bodies.push(body);
        if (body.tools) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'registry.ollama.ai/library/tinyllama does not support tools' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply } }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterEach(() => server.close());

  const request = (messages: Message[] = [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'what is in a.ts?' }], createdAt: 0 }]): ChatRequest => ({
    model: { ref: 'local:tiny', provider: 'local', id: 'tiny', name: 'Tiny', contextWindow: 8192, maxOutput: 2048 },
    system: 'You are a test.',
    messages,
    tools: [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    maxTokens: 512,
  });

  it('switches to the text protocol and still returns a real tool call', async () => {
    const p = new OpenAICompatProvider({ id: 'local', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
    reply = '<think>The user wants a.ts.</think>Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>';
    const events: StreamEvent[] = [];
    const res = await p.chat(request(), (e) => events.push(e));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.tools).toBeUndefined();
    const system = (bodies[1]?.messages as { role: string; content: string }[])[0]?.content ?? '';
    expect(system).toContain('# Calling tools');
    expect(system).toContain('## read_file');
    expect(res.parts.find((x) => x.type === 'tool_call')).toMatchObject({ name: 'read_file', input: { path: 'a.ts' } });
    expect(res.parts.find((x) => x.type === 'text')).toMatchObject({ text: 'Let me look.' });
    expect(res.parts.find((x) => x.type === 'thinking')).toMatchObject({ text: 'The user wants a.ts.' });
    expect(res.stopReason).toBe('tool_use');
    expect(events.some((e) => e.type === 'notice' && /text tool protocol/.test(e.text))).toBe(true);
    // the streamed text stops where the call begins
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).not.toContain('<tool_call>');

    // the next request goes straight to the text protocol and replays the call and its result as text
    const call: ToolCallPart = { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } };
    reply = 'a.ts exports answer = 42.';
    const next = await p.chat(
      request([
        { id: 'u', role: 'user', parts: [{ type: 'text', text: 'what is in a.ts?' }], createdAt: 0 },
        { id: 'a', role: 'assistant', parts: [call], createdAt: 1 },
        { id: 't', role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'c1', toolName: 'read_file', content: 'export const answer = 42;' }], createdAt: 2 },
      ]),
      () => undefined,
    );
    expect(bodies).toHaveLength(3);
    const msgs = bodies[2]?.messages as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[2]?.content).toContain('<tool_call>');
    expect(msgs[3]?.content).toContain('<tool_result name="read_file">');
    expect(next.parts).toEqual([{ type: 'text', text: 'a.ts exports answer = 42.' }]);
  });
});

describe('agent loop with a weak model', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeRuntime();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  const usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const scripted = (turns: ((req: ChatRequest) => ChatResponse['parts'])[]) => {
    let i = 0;
    const seen: ChatRequest[] = [];
    const provider = {
      id: 'kronos',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        seen.push(req);
        const parts = (turns[Math.min(i++, turns.length - 1)] as (req: ChatRequest) => ChatResponse['parts'])(req);
        return { parts, stopReason: parts.some((p) => p.type === 'tool_call') ? 'tool_use' : 'end_turn', usage, model: 'weak' };
      },
    } as Provider;
    (env.rt.providers as unknown as { cache: Map<string, Provider> }).cache.set('kronos', provider);
    return seen;
  };
  const toolResults = (sessionId: string) => env.rt.sessions.messages(sessionId).flatMap((m) => m.parts).filter((p) => p.type === 'tool_result') as { toolName: string; content: string; isError?: boolean }[];
  const notes = (sessionId: string) => env.rt.sessions.messages(sessionId).filter((m) => m.meta?.kind === 'note').map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));

  it('runs a call made with the wrong tool and argument names', async () => {
    scripted([
      () => [{ type: 'tool_call', id: 'c1', name: 'bash', input: { cmd: 'echo kronos-weak' } }],
      () => [{ type: 'text', text: 'Done: it printed kronos-weak.' }],
    ]);
    const s = env.rt.createSession({ source: 'test' });
    const r = await env.rt.agent(s.id).run('print something');
    expect(r.text).toBe('Done: it printed kronos-weak.');
    const [result] = toolResults(s.id);
    expect(result?.toolName).toBe('shell');
    expect(result?.isError).toBeFalsy();
    expect(result?.content).toContain('kronos-weak');
  });

  it('teaches the right shape when arguments are wrong', async () => {
    scripted([
      () => [{ type: 'tool_call', id: 'c1', name: 'read_file', input: { nonsense: 1 } }],
      () => [{ type: 'text', text: 'ok' }],
    ]);
    const s = env.rt.createSession({ source: 'test' });
    await env.rt.agent(s.id).run('read it');
    const [result] = toolResults(s.id);
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/Expected arguments for read_file:\n- path \(string, required\)/);
    expect(result?.content).toContain('Example: {"name":"read_file","arguments":{"path":"<path>"}}');
  });

  it('nudges a model that announces an action without calling a tool, or replies with nothing', async () => {
    scripted([
      () => [{ type: 'text', text: 'I found the problem. Let me run the tests now.' }],
      () => [],
      () => [{ type: 'tool_call', id: 'c1', name: 'shell', input: { command: 'echo tests-pass' } }],
      () => [{ type: 'text', text: 'All tests pass.' }],
    ]);
    const s = env.rt.createSession({ source: 'test' });
    const r = await env.rt.agent(s.id).run('fix the bug');
    expect(r.text).toBe('All tests pass.');
    expect(notes(s.id)).toEqual([expect.stringMatching(/did not call a tool/), expect.stringMatching(/last reply was empty/)]);
    expect(toolResults(s.id)[0]?.content).toContain('tests-pass');
  });

  it('never blocks a real final answer', async () => {
    const seen = scripted([() => [{ type: 'text', text: 'The capital of France is Paris.' }]]);
    const r = await env.rt.agent(env.rt.createSession({ source: 'test' }).id).run('capital of France?');
    expect(r.text).toBe('The capital of France is Paris.');
    expect(seen.filter((r) => r.tools.length)).toHaveLength(1); // the other request is the chat title
  });
});

describe('lean mode', () => {
  it('gives small models the core tools and a compact prompt', async () => {
    const env = await makeRuntime({ agent: { lean: 'on' } } as never);
    try {
      const s = env.rt.createSession({ source: 'test' });
      await env.rt.agent(s.id).run('hello');
      const session = env.rt.sessions.get(s.id);
      expect(session?.toolNames?.length).toBeLessThanOrEqual(14);
      expect(session?.toolNames).toContain('edit_file');
      expect(session?.toolNames).not.toContain('delegate');
      expect(session?.systemPrompt).toContain('# Rules');
      expect((session?.systemPrompt ?? '').length).toBeLessThan(4000);
      expect(session?.meta?.lean).toBe(true);
    } finally {
      await env.cleanup();
    }
  });
});
