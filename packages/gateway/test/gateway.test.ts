import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Kronos } from '@kronos/core';
import { Gateway } from '@kronos/gateway';

let gw: Gateway;
let home: string;
let ws: string;

beforeAll(async () => {
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), 'kronos-gw-home-'));
  ws = mkdtempSync(join(tmpdir(), 'kronos-gw-ws-'));
  writeFileSync(join(ws, 'readme.md'), '# test workspace');
  const rt = await Kronos.create({
    home,
    cwd: ws,
    connectMcp: false,
    logLevel: 'silent',
    overrides: { model: { default: 'kronos:demo' }, safety: { mode: 'yolo' }, skills: { claudeCompat: false } } as never,
  });
  gw = await Gateway.start(rt, { port: 0, host: '127.0.0.1', platforms: false, cron: false, token: 'secret-token' });
});

afterAll(async () => {
  await gw.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

const auth = { authorization: 'Bearer secret-token' };
async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${gw.url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...auth, ...(init.headers ?? {}) } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

describe('gateway REST', () => {
  it('requires the token', async () => {
    const res = await fetch(`${gw.url}/api/status`);
    expect(res.status).toBe(401);
    expect((await fetch(`${gw.url}/api/health`)).status).toBe(200);
  });
  it('reports status, config, providers, toolsets and skills', async () => {
    const status = await api('/api/status');
    expect(status.demo).toBe(true);
    expect(status.model.ref).toBe('kronos:demo');
    const cfg = await api('/api/config');
    expect(cfg.sections.length).toBeGreaterThan(5);
    const providers = await api<any[]>('/api/providers');
    expect(providers.some((p) => p.id === 'anthropic')).toBe(true);
    const toolsets = await api<any[]>('/api/toolsets');
    expect(toolsets.find((t) => t.id === 'files').tools.length).toBeGreaterThan(5);
    const patched = await api('/api/config', { method: 'PATCH', body: JSON.stringify({ ui: { theme: 'ember' } }) });
    expect(patched.config.ui.theme).toBe('ember');
  });
  it('manages sessions, files, memory, cron and profiles', async () => {
    const s = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'Hello' }) });
    expect(s.title).toBe('Hello');
    await api(`/api/sessions/${s.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: true, title: 'Renamed' }) });
    const list = await api<any[]>('/api/sessions');
    expect(list.find((x) => x.id === s.id).pinned).toBe(true);
    const files = await api(`/api/files?path=${encodeURIComponent(ws)}`);
    expect(files.entries.some((e: { name: string }) => e.name === 'readme.md')).toBe(true);
    const content = await api(`/api/files/read?path=${encodeURIComponent(join(ws, 'readme.md'))}`);
    expect(content.content).toContain('test workspace');
    await api('/api/memory/user', { method: 'PUT', body: JSON.stringify({ entries: ['Likes dark mode'] }) });
    expect((await api('/api/memory')).user.entries).toEqual(['Likes dark mode']);
    const job = await api('/api/cron', { method: 'POST', body: JSON.stringify({ schedule: 'weekdays at 9am', prompt: 'list files' }) });
    expect(job.description).toBe('weekdays 09:00');
    const created = await api('/api/profiles', { method: 'POST', body: JSON.stringify({ name: 'work', soul: 'You are a focused work assistant.' }) });
    expect(created.name).toBe('work');
    expect((await api<any[]>('/api/profiles')).map((p) => p.name)).toContain('work');
  });
});

describe('gateway WebSocket chat', () => {
  it('streams a full agent run with tool events', async () => {
    const sock = new WebSocket(`${gw.url.replace('http', 'ws')}/ws?token=secret-token`);
    const events: any[] = [];
    let sessionId = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 15000);
      sock.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'ready') sock.send(JSON.stringify({ type: 'chat', text: 'list files', requestId: 'r1' }));
        if (msg.type === 'chat_ack') sessionId = msg.sessionId;
        if (msg.type === 'event') {
          events.push(msg.event);
          if (msg.event.type === 'run_end') {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      sock.on('error', reject);
    });
    sock.close();
    expect(sessionId).toMatch(/^s_/);
    expect(events.some((e) => e.type === 'tool_call' && e.name === 'list_dir')).toBe(true);
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    const detail = await api(`/api/sessions/${sessionId}`);
    expect(detail.messages.length).toBeGreaterThanOrEqual(4);
    const md = await (await fetch(`${gw.url}/api/sessions/${sessionId}/export?format=md`, { headers: auth })).text();
    expect(md).toContain('list files');
  });
});

describe('OpenAI-compatible API', () => {
  it('answers non-streaming and streaming requests', async () => {
    const models = await api('/v1/models');
    expect(models.data[0].id).toBe('kronos');
    const res = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'kronos', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.choices[0].message.content).toContain('Kronos');
    const stream = await fetch(`${gw.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ model: 'kronos', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    });
    const text = await stream.text();
    expect(text).toContain('chat.completion.chunk');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('terminal', () => {
  it('runs commands in a PTY over WebSocket', async () => {
    const sock = new WebSocket(`${gw.url.replace('http', 'ws')}/ws/terminal?token=secret-token&cols=80&rows=24&cwd=${encodeURIComponent(ws)}`);
    let out = '';
    let mode = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; output so far: ${out.slice(-300)}`)), 15000);
      sock.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'ready') {
          mode = msg.mode;
          sock.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
          sock.send(JSON.stringify({ type: 'input', data: 'echo KRONOS_$((40+2))\r' }));
        }
        if (msg.type === 'output') {
          out += msg.data;
          if (out.includes('KRONOS_42')) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
    sock.close();
    expect(['pty', 'script', 'pipe']).toContain(mode);
  });
});
