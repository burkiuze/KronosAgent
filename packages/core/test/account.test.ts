import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRuntime, type TestEnv } from './helpers.js';

/** A stand-in for heynavio.com's Kronos API: PKCE token exchange, account, promo codes, chat. */
function fakeCloud() {
  const state = { plan: null as null | 'pro', challenge: '', redirect: '', chats: [] as { auth?: string; model?: string }[], used: false };
  const account = () => ({
    email: 'ada@example.com',
    plan: state.plan ? { id: state.plan, name: 'Pro' } : null,
    planExpiresAt: null,
    usage: { fiveHour: { spentMicro: 0, limitMicro: 2e6, percent: 0, resetsAt: null }, week: { spentMicro: 0, limitMicro: 15e6, percent: 0, resetsAt: null } },
  });
  const TOKEN = 'kro_test_token_0123456789abcdef';
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const authed = req.headers.authorization === `Bearer ${TOKEN}`;
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/api/kronos/token') {
        const b = JSON.parse(body) as { code: string; code_verifier: string; redirect_uri: string };
        const ok = b.code === 'one-time-code' && !state.used && b.redirect_uri === state.redirect && createHash('sha256').update(b.code_verifier).digest('base64url') === state.challenge;
        if (!ok) return json(400, { error: { code: 'invalid_grant', message: 'This sign-in link has expired or does not match.' } });
        state.used = true;
        return json(200, { token: TOKEN, account: account() });
      }
      if (!authed) return json(401, { error: { code: 'unauthorized', message: 'Sign in to Kronos again.' } });
      if (url.pathname === '/api/kronos/me') return json(200, { account: account() });
      if (url.pathname === '/api/kronos/redeem') {
        if (JSON.parse(body).code !== 'WELCOME') return json(400, { error: { code: 'invalid', message: 'This code is not valid.' } });
        state.plan = 'pro';
        return json(200, { ok: true, account: account() });
      }
      if (url.pathname === '/api/kronos/logout') return json(200, { ok: true });
      if (url.pathname === '/api/kronos/v1/chat/completions') {
        state.chats.push({ auth: req.headers.authorization, model: JSON.parse(body).model });
        if (!state.plan) return json(402, { error: { code: 'membership_required', message: 'Kronos Cloud models need a membership.' } });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello from Kronos Cloud.' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      json(404, { error: { message: 'no route' } });
    });
  });
  return { server, state, TOKEN };
}

describe('Kronos account and Kronos Cloud', () => {
  let env: TestEnv;
  let cloud: ReturnType<typeof fakeCloud>;
  beforeEach(async () => {
    cloud = fakeCloud();
    await new Promise<void>((r) => cloud.server.listen(0, '127.0.0.1', () => r()));
    process.env.KRONOS_CLOUD_URL = `http://127.0.0.1:${(cloud.server.address() as AddressInfo).port}`;
    env = await makeRuntime();
  });
  afterEach(async () => {
    await env.cleanup();
    cloud.server.close();
    delete process.env.KRONOS_CLOUD_URL;
    delete process.env.KRONOS_CLOUD_TOKEN;
  });

  it('talks to www.heynavio.com, where a redirect cannot strip the app token', () => {
    delete process.env.KRONOS_CLOUD_URL;
    expect(env.rt.account.cloudUrl()).toBe('https://www.heynavio.com');
    process.env.KRONOS_CLOUD_URL = 'https://heynavio.com/';
    expect(env.rt.account.cloudUrl()).toBe('https://www.heynavio.com');
    expect(env.rt.account.apiBase()).toBe('https://www.heynavio.com/api/kronos/v1');
    process.env.KRONOS_CLOUD_URL = 'https://heynavio.com.example.org';
    expect(env.rt.account.cloudUrl()).toBe('https://heynavio.com.example.org');
  });

  it('starts on the first-run screen, and remembers "continue without an account"', () => {
    const s = env.rt.account.status();
    expect(s).toMatchObject({ signedIn: false, skipped: false, onboarded: false });
    expect(s.models.map((m) => m.id)).toContain('glm-5.3-flash');
    expect(env.rt.account.skip().onboarded).toBe(true);
    expect(env.rt.account.status().onboarded).toBe(true);
  });

  it('lists Kronos Cloud models locked until sign-in and a membership, then serves them with the account token', async () => {
    const lockedOut = await env.rt.providers.listModels();
    expect(lockedOut.filter((m) => m.provider === 'cloud').every((m) => m.locked === 'sign_in')).toBe(true);
    expect(env.rt.providers.readiness('cloud:glm-5.3-flash').ok).toBe(false);

    // sign in: the URL carries a PKCE challenge; the code is only traded with the matching verifier
    const redirect = 'http://127.0.0.1:7777/api/account/callback';
    const { url, state } = env.rt.account.startLogin(redirect, { mode: 'sign-up' });
    const u = new URL(url);
    expect(u.pathname).toBe('/kronosagent/connect');
    expect(u.searchParams.get('mode')).toBe('sign-up');
    cloud.state.challenge = u.searchParams.get('code_challenge') ?? '';
    cloud.state.redirect = u.searchParams.get('redirect_uri') ?? '';
    await expect(env.rt.account.completeLogin('one-time-code', 'forged-state')).rejects.toThrow(/expired/);
    const s = await env.rt.account.completeLogin('one-time-code', state);
    expect(s).toMatchObject({ signedIn: true, onboarded: true, account: { email: 'ada@example.com', plan: null } });
    expect(readFileSync(join(env.home, '.env'), 'utf8')).toContain(`KRONOS_CLOUD_TOKEN=${cloud.TOKEN}`);
    // a used state cannot be replayed
    await expect(env.rt.account.completeLogin('one-time-code', state)).rejects.toThrow(/expired/);

    // signed in without a plan: still locked, now for a membership
    expect((await env.rt.providers.listModels()).find((m) => m.ref === 'cloud:glm-5.3-flash')?.locked).toBe('membership');
    await expect(env.rt.account.redeem('NOPE')).rejects.toThrow(/not valid/);
    const member = await env.rt.account.redeem('WELCOME');
    expect(member.account?.plan?.name).toBe('Pro');
    expect((await env.rt.providers.listModels()).find((m) => m.ref === 'cloud:glm-5.3-flash')?.locked).toBeUndefined();
    expect(env.rt.providers.readiness('cloud:glm-5.3-flash').ok).toBe(true);

    // a chat on a Kronos Cloud model goes to the cloud API with the account token
    const session = env.rt.createSession({ source: 'test', model: 'cloud:glm-5.3-flash' });
    const r = await env.rt.agent(session.id).run('hi');
    expect(r.text).toBe('Hello from Kronos Cloud.');
    expect(cloud.state.chats.at(-1)).toEqual({ auth: `Bearer ${cloud.TOKEN}`, model: 'glm-5.3-flash' });

    // signing out removes the token and locks the models again
    const out = await env.rt.account.logout();
    expect(out.signedIn).toBe(false);
    expect(readFileSync(join(env.home, '.env'), 'utf8')).not.toContain('KRONOS_CLOUD_TOKEN');
    expect(env.rt.providers.readiness('cloud:glm-5.3-flash').ok).toBe(false);
  });

  it('signs out when the server no longer accepts the token, and does not retry a missing membership', async () => {
    process.env.KRONOS_CLOUD_TOKEN = 'kro_revoked_token_000000000000';
    const s = await env.rt.account.refresh();
    expect(s.signedIn).toBe(false);
    expect(s.error).toMatch(/sign in again/i);

    process.env.KRONOS_CLOUD_TOKEN = cloud.TOKEN;
    await env.rt.account.refresh(); // signed in, no plan
    // pretend the cache says member so the request is made; the server refuses with 402
    const before = cloud.state.chats.length;
    env.rt.providers.setCloud({ access: () => ({ signedIn: true, member: true }), apiBase: () => env.rt.account.apiBase() });
    const session = env.rt.createSession({ source: 'test', model: 'cloud:glm-5.3-flash' });
    const r = await env.rt.agent(session.id).run('hi');
    expect(r.error ?? r.text).toMatch(/membership/);
    expect(cloud.state.chats.length - before).toBe(1);
  });
});
