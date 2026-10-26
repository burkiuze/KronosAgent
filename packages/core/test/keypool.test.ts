import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeRuntime, type TestEnv } from './helpers.js';

let server: Server;
let url = '';
const seen: string[] = [];
let env: TestEnv;

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = String(req.headers.authorization ?? '').replace('Bearer ', '');
    seen.push(key);
    req.resume();
    req.on('end', () => {
      if (key === 'key-one') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
        res.end(JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: `hi from ${key}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  env = await makeRuntime({ model: { default: 'pool:m1', stream: false }, customProviders: [{ id: 'pool', label: 'Pool', baseUrl: url, apiKey: 'key-one, key-two', api: 'openai', models: [{ id: 'm1' }] }] } as never);
});

afterAll(async () => {
  server.close();
  await env.cleanup();
});

describe('API key pool', () => {
  it('switches to the next key on a rate limit instead of waiting or falling back', async () => {
    expect(env.rt.providers.keysFor('pool')).toEqual(['key-one', 'key-two']);
    const notices: string[] = [];
    const res = await env.rt.providers.chat(
      { model: env.rt.providers.resolve('pool:m1'), system: '', messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 0 }], tools: [], maxTokens: 50 } as never,
      (e) => e.type === 'notice' && notices.push(e.text),
    );
    expect(res.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'hi from key-two' });
    expect(seen.slice(0, 2)).toEqual(['key-one', 'key-two']);
    expect(notices.join('\n')).toMatch(/key rate limited — switched to key 2 of 2/);
    // the cooled-down key is skipped on the next request
    seen.length = 0;
    await env.rt.providers.chat({ model: env.rt.providers.resolve('pool:m1'), system: '', messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'again' }], createdAt: 0 }], tools: [], maxTokens: 50 } as never, () => undefined);
    expect(seen).toEqual(['key-two']);
  });
});
