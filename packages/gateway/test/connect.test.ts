import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Kronos } from '@kronos/core';
import type { ChatResponse, Provider } from '@kronos/core';
import { Gateway } from '@kronos/gateway';

const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY'];

let gw: Gateway;
let rt: Kronos;
let home: string;
let sessionId: string;

// a fresh install: model "auto", no keys anywhere
beforeAll(async () => {
  for (const k of KEYS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), 'kronos-connect-'));
  rt = await Kronos.create({ home, cwd: home, connectMcp: false, logLevel: 'silent', overrides: { skills: { claudeCompat: false } } as never });
  gw = await Gateway.start(rt, { port: 0, host: '127.0.0.1', platforms: false, cron: false, token: 't' });
});

afterAll(async () => {
  await gw.close();
  rmSync(home, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit = {}) => fetch(`${gw.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer t' } });

describe('no provider connected', () => {
  it('reports it in the status instead of offering the demo model', async () => {
    const status = await (await api('/api/status')).json();
    expect(status.needsProvider).toBe(true);
  });

  it('accepts a chat over the WebSocket, keeps the message and sends a no_provider notice', async () => {
    const sock = new WebSocket(`${gw.url.replace('http', 'ws')}/ws?token=t`);
    await new Promise((r) => sock.on('open', r));
    const seen: Record<string, unknown>[] = [];
    const notice = new Promise<Record<string, unknown>>((resolve) =>
      sock.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        seen.push(m);
        if (m.type === 'event' && m.event?.type === 'notice') resolve(m.event);
      }),
    );
    sock.send(JSON.stringify({ type: 'chat', requestId: 'r1', text: 'hello' }));
    const n = await notice;
    sock.close();
    expect(n).toMatchObject({ level: 'error', code: 'no_provider' });
    expect(String(n.text)).toMatch(/No model provider is connected/);
    const ack = seen.find((m) => m.type === 'chat_ack');
    expect(ack).toMatchObject({ requestId: 'r1' });
    sessionId = String(ack?.sessionId);
    expect(rt.sessions.messages(sessionId)).toEqual([expect.objectContaining({ role: 'user', meta: { unanswered: 'no_provider' } })]);
  });

  it('refuses the REST and OpenAI-compatible endpoints with 409', async () => {
    const chat = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text: 'hi', wait: true }) });
    expect(chat.status).toBe(409);
    expect((await chat.json()).code).toBe('no_provider');
    const v1 = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'kronos', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(v1.status).toBe(409);
  });

  it('runs normally once a provider is connected', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    (rt.providers as unknown as { cache: Map<string, Provider> }).cache.set('openai', {
      id: 'openai',
      async chat(): Promise<ChatResponse> {
        return { parts: [{ type: 'text', text: 'Hi from a real provider' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'gpt' };
      },
    } as Provider);
    try {
      expect((await (await api('/api/status')).json()).needsProvider).toBe(false);
      const res = await (await api('/api/chat', { method: 'POST', body: JSON.stringify({ text: 'hi', wait: true }) })).json();
      expect(res.text).toBe('Hi from a real provider');
      // the message held earlier gets its answer
      await api(`/api/sessions/${sessionId}/answer`, { method: 'POST' });
      for (let i = 0; i < 50 && !rt.sessions.messages(sessionId).some((m) => m.role === 'assistant'); i++) await new Promise((r) => setTimeout(r, 20));
      const msgs = rt.sessions.messages(sessionId).filter((m) => m.role !== 'system');
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(msgs[0]?.meta?.unanswered).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});
