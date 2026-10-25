import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatProvider, getPreset, type AgentEvent, type StreamEvent } from '@kronos/core';
import { DeltaCoalescer } from '../src/coalesce.js';

describe('delta coalescing', () => {
  it('merges consecutive deltas, flushes before other events and keeps order', async () => {
    const out: { sessionId: string; event: AgentEvent }[] = [];
    const c = new DeltaCoalescer((sessionId, event) => out.push({ sessionId, event }), 10);
    const text = (t: string): AgentEvent => ({ type: 'text_delta', runId: 'r1', text: t });
    c.push('a', { type: 'turn_start', runId: 'r1', iteration: 1 });
    c.push('a', text('Hel'));
    c.push('a', text('lo'));
    c.push('b', text('other session'));
    c.push('a', { type: 'thinking_delta', runId: 'r1', text: 'hmm' });
    c.push('a', { type: 'tool_call_delta', runId: 'r1', id: 't1', partialJson: '{"a":' });
    c.push('a', { type: 'tool_call_delta', runId: 'r1', id: 't1', partialJson: '1}' });
    c.push('a', { type: 'tool_call_delta', runId: 'r1', id: 't2', partialJson: '{}' });
    // a non-delta event delivers what is pending for its session first, then itself
    c.push('a', { type: 'tool_call', runId: 'r1', id: 't1', name: 'x', input: {}, summary: 'x' } as AgentEvent);
    expect(out.map((o) => `${o.sessionId}:${o.event.type}`)).toEqual([
      'a:turn_start',
      'a:text_delta',
      'a:thinking_delta',
      'a:tool_call_delta',
      'a:tool_call_delta',
      'a:tool_call',
    ]);
    expect(out[1]?.event).toMatchObject({ text: 'Hello' });
    expect(out[3]?.event).toMatchObject({ id: 't1', partialJson: '{"a":1}' });
    // session b is delivered by the timer
    await new Promise((r) => setTimeout(r, 30));
    expect(out[6]).toMatchObject({ sessionId: 'b', event: { text: 'other session' } });
  });

  it('never mutates the events it was given', () => {
    const c = new DeltaCoalescer(() => undefined, 10);
    const first: AgentEvent = { type: 'text_delta', runId: 'r', text: 'a' };
    c.push('s', first);
    c.push('s', { type: 'text_delta', runId: 'r', text: 'b' });
    c.flushAll();
    expect(first).toMatchObject({ text: 'a' });
  });
});

describe('OpenAI-compatible streaming', () => {
  it('parses server-sent events split at arbitrary byte boundaries', async () => {
    const chunks = ['Hel', 'lo, ', 'wörld', ' — ✓'];
    const events = [
      ...chunks.map((c) => ({ choices: [{ index: 0, delta: { content: c } }] })),
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.md"}' } }] }, finish_reason: 'tool_calls' }] },
    ];
    const body = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // 7-byte slices cut through lines, JSON and multi-byte characters
      let i = 0;
      const next = () => {
        if (i >= body.length) return res.end();
        res.write(body.subarray(i, (i += 7)));
        setImmediate(next);
      };
      next();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const preset = getPreset('openai')!;
      const provider = new OpenAICompatProvider({ ...preset, id: 'openai', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: 'sk-test' } as never);
      const deltas: string[] = [];
      const res = await provider.chat(
        { model: { ref: 'openai:x', id: 'x', provider: 'openai', name: 'x', contextWindow: 1000, maxOutput: 100 } as never, system: '', messages: [], tools: [], maxTokens: 100 } as never,
        (e: StreamEvent) => e.type === 'text' && deltas.push(e.text),
      );
      expect(deltas.join('')).toBe('Hello, wörld — ✓');
      expect(res.parts).toContainEqual({ type: 'text', text: 'Hello, wörld — ✓' });
      expect(res.parts).toContainEqual({ type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.md' } });
      expect(res.stopReason).toBe('tool_use');
    } finally {
      server.close();
    }
  });
});
