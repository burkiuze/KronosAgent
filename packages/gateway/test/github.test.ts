import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Kronos, parseGitHubRemote } from '@kronos/core';
import type { ChatResponse, Provider, ToolCallPart } from '@kronos/core';
import { Gateway } from '@kronos/gateway';
import { githubTool } from '../../core/src/github/tool.js';

/**
 * The GitHub integration end to end, against a fake GitHub API and a local "GitHub" (bare git
 * repositories under a file:// web URL): app creation by manifest, signed webhooks, the bot
 * turning an @mention into a pushed branch and a pull request, and the agent's github tool.
 */

const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN'];
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const WEBHOOK_SECRET = 'whsec_test';

let root: string;
let api: Server;
let apiUrl: string;
let rt: Kronos;
let gw: Gateway;
const calls: { method: string; path: string; auth: string; body: Record<string, unknown> }[] = [];

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function fakeGitHub(): Server {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] as string;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls.push({ method: req.method ?? '', path, auth: String(req.headers.authorization ?? ''), body });
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const m = (re: RegExp) => re.exec(`${req.method} ${path}`);
      if (m(/^POST \/app-manifests\/good-code\/conversions$/))
        return send(201, { id: 42, slug: 'kronos-test', name: 'kronos-test', owner: { login: 'acme' }, html_url: 'https://github.com/apps/kronos-test', client_id: 'Iv1.x', client_secret: 's', webhook_secret: WEBHOOK_SECRET, pem: privateKey });
      if (m(/^GET \/repos\/acme\/widgets\/installation$/)) return send(200, { id: 7 });
      if (m(/^GET \/repos\/[^/]+\/[^/]+\/installation$/)) return send(404, { message: 'Not Found' });
      if (m(/^POST \/app\/installations\/7\/access_tokens$/)) return send(201, { token: 'ghs_installation', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (m(/^GET \/app\/installations$/)) return send(200, [{ id: 7, account: { login: 'acme' }, repository_selection: 'selected' }]);
      if (m(/^GET \/app\/hook\/config$/)) return send(200, { url: 'https://kronos.example.com/hooks/github' });
      if (m(/^GET \/installation\/repositories$/))
        return send(200, { repositories: [{ full_name: 'acme/widgets', private: true, description: 'Widgets', default_branch: 'main', updated_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/acme/widgets' }] });
      if (m(/^GET \/users\/kronos-test(%5B|\[)bot(%5D|\])$/)) return send(200, { id: 99 });
      if (m(/^GET \/repos\/acme\/widgets$/)) return send(200, { default_branch: 'main' });
      if (m(/^POST \/repos\/acme\/widgets\/issues\/comments\/\d+\/reactions$/)) return send(201, {});
      if (m(/^POST \/repos\/acme\/widgets\/issues\/\d+\/comments$/)) return send(201, { id: 1001, html_url: 'https://github.com/acme/widgets/issues/5#c1001' });
      if (m(/^PATCH \/repos\/acme\/widgets\/issues\/comments\/1001$/)) return send(200, { id: 1001 });
      if (m(/^GET \/repos\/acme\/widgets\/issues\/\d+\/comments$/)) return send(200, []);
      if (m(/^POST \/repos\/acme\/widgets\/pulls$/)) return send(201, { number: 12, html_url: 'https://github.com/acme/widgets/pull/12' });
      send(404, { message: `fake: no route ${req.method} ${path}` });
    });
  });
}

beforeAll(async () => {
  for (const k of KEYS) delete process.env[k];
  root = mkdtempSync(join(tmpdir(), 'kronos-gh-'));
  // "GitHub": a bare repository acme/widgets with one commit on main
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), '# widgets\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  execFileSync('git', ['clone', '-q', '--bare', seed, join(root, 'remote', 'acme', 'widgets.git')]);

  api = fakeGitHub();
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  rt = await Kronos.create({
    home: join(root, 'home'),
    cwd: root,
    connectMcp: false,
    logLevel: 'silent',
    overrides: {
      model: { default: 'kronos:demo' },
      skills: { claudeCompat: false },
      github: { apiUrl, webUrl: `file://${join(root, 'remote')}`, token: '' },
    } as never,
  });
  gw = await Gateway.start(rt, { port: 0, host: '127.0.0.1', platforms: false, cron: false, token: 't' });
});

afterAll(async () => {
  await gw?.close();
  api?.close();
  rmSync(root, { recursive: true, force: true });
});

const authed = (path: string, init: RequestInit = {}) => fetch(`${gw.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, redirect: 'manual' });

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

async function deliver(event: string, payload: unknown, delivery: string, signature?: string): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${gw.url}/hooks/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': signature ?? sign(body) },
    body,
  });
}

const issueComment = (over: { body?: string; association?: string; senderType?: string } = {}) => ({
  action: 'created',
  installation: { id: 7 },
  repository: { full_name: 'acme/widgets', default_branch: 'main' },
  sender: { login: 'ada', type: over.senderType ?? 'User' },
  issue: { number: 5, title: 'Widgets need a fix note', body: 'Please add FIX.md explaining the fix.', html_url: 'https://github.com/acme/widgets/issues/5', author_association: 'OWNER', user: { login: 'ada' } },
  comment: { id: 555, body: over.body ?? '@kronos please fix this', author_association: over.association ?? 'OWNER', user: { login: 'ada', type: 'User' } },
});

describe('GitHub', () => {
  it('reads owner/repo from remote URLs', () => {
    expect(parseGitHubRemote('https://github.com/acme/widgets.git')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(parseGitHubRemote('git@github.com:acme/widgets.git')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(parseGitHubRemote('https://x-access-token@github.com/acme/widgets')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(parseGitHubRemote('https://gitlab.com/acme/widgets.git')).toBeUndefined();
  });

  it('creates the Kronos GitHub App from a manifest, guarded by state', async () => {
    const r = await (await authed('/api/github/app/manifest', { method: 'POST', body: JSON.stringify({ baseUrl: gw.url, publicUrl: 'https://kronos.example.com' }) })).json();
    expect(r.action).toMatch(/\/settings\/apps\/new\?state=[0-9a-f]{32}$/);
    expect(r.manifest).toMatchObject({
      hook_attributes: { url: 'https://kronos.example.com/hooks/github', active: true },
      redirect_url: `${gw.url}/hooks/github/app-created`,
      default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
    });
    const bad = await fetch(`${gw.url}/hooks/github/app-created?code=good-code&state=forged`, { redirect: 'manual' });
    expect(bad.headers.get('location')).toMatch(/github=error/);
    expect(rt.github.app()).toBeUndefined();
    const state = new URL(r.action).searchParams.get('state');
    const ok = await fetch(`${gw.url}/hooks/github/app-created?code=good-code&state=${state}`, { redirect: 'manual' });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/?github=created&app=kronos-test');
    expect(rt.github.app()).toMatchObject({ id: 42, slug: 'kronos-test', webhookSecret: WEBHOOK_SECRET });
    expect(existsSync(join(rt.paths.root, 'github-app.json'))).toBe(true);
  });

  it('authenticates as the app with a signed JWT and uses installation tokens for its repositories', async () => {
    const jwt = rt.github.appJwt();
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({ iss: '42' });
    expect(await rt.github.tokenFor('acme/widgets')).toEqual({ token: 'ghs_installation', kind: 'app' });
    await expect(rt.github.tokenFor('someone/else')).rejects.toThrow(/not installed on someone\/else/);
    const status = await (await authed('/api/github/status')).json();
    expect(status).toMatchObject({ connected: true, app: { slug: 'kronos-test', installations: [{ account: 'acme' }], webhook: true } });
    const repos = await (await authed('/api/github/repos')).json();
    expect(repos.map((x: { fullName: string }) => x.fullName)).toEqual(['acme/widgets']);
  });

  it('rejects unsigned deliveries and ignores what it should not act on', async () => {
    expect((await deliver('issue_comment', issueComment(), 'd-bad', 'sha256=deadbeef')).status).toBe(401);
    for (const [i, payload] of [issueComment({ body: 'just a comment' }), issueComment({ association: 'NONE' }), issueComment({ senderType: 'Bot' })].entries()) {
      const res = await deliver('issue_comment', payload, `d-ignored-${i}`);
      expect(await res.json()).toMatchObject({ ignored: true });
    }
  });

  it('turns an @mention into a pushed branch, a pull request and a reply', async () => {
    // the "model": write the fix, commit it, then report
    let step = 0;
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    (rt.providers as unknown as { cache: Map<string, Provider> }).cache.set('kronos', {
      id: 'kronos',
      async chat(req): Promise<ChatResponse> {
        if (!req.tools.length) return { parts: [{ type: 'text', text: 'Fix note' }], stopReason: 'end_turn', usage, model: 'scripted' }; // titles
        step++;
        const call = (name: string, input: Record<string, unknown>): ChatResponse => ({ parts: [{ type: 'tool_call', id: `c${step}`, name, input } as ToolCallPart], stopReason: 'tool_use', usage, model: 'scripted' });
        if (step === 1) return call('write_file', { path: 'FIX.md', content: 'The widgets are fixed.\n' });
        if (step === 2) return call('shell', { command: 'git add FIX.md && git commit -q -m "Add FIX.md"' });
        return { parts: [{ type: 'text', text: 'Added FIX.md describing the fix.' }], stopReason: 'end_turn', usage, model: 'scripted' };
      },
    } as Provider);

    const res = await deliver('issue_comment', issueComment(), 'd-run');
    expect(res.status).toBe(202);
    // a duplicate delivery is handled once
    expect(await (await deliver('issue_comment', issueComment(), 'd-run')).json()).toMatchObject({ ignored: true });

    let edited: (typeof calls)[number] | undefined;
    for (let i = 0; i < 200 && !edited; i++) {
      await new Promise((r) => setTimeout(r, 50));
      edited = calls.find((c) => c.method === 'PATCH' && c.path === '/repos/acme/widgets/issues/comments/1001');
    }
    expect(edited, JSON.stringify(calls.slice(-5))).toBeDefined();
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/comments/555/reactions') && c.body.content === 'eyes')).toBe(true);
    const pr = calls.find((c) => c.method === 'POST' && c.path === '/repos/acme/widgets/pulls');
    expect(pr?.body).toMatchObject({ base: 'main', title: 'Fix #5: Widgets need a fix note' });
    expect(String(pr?.body.head)).toMatch(/^kronos\/issue-5-/);
    expect(String(pr?.body.body)).toContain('Added FIX.md describing the fix.');
    expect(String(pr?.body.body)).toContain('Closes #5');
    expect(pr?.auth).toBe('Bearer ghs_installation');
    expect(String(edited?.body.body)).toContain('https://github.com/acme/widgets/pull/12');

    // the branch really is on "GitHub", committed as the bot
    const bare = join(root, 'remote', 'acme', 'widgets.git');
    const branch = String(pr?.body.head);
    expect(git(bare, 'show', `${branch}:FIX.md`)).toBe('The widgets are fixed.');
    expect(git(bare, 'log', '-1', '--format=%an <%ae>', branch)).toBe('kronos-test[bot] <99+kronos-test[bot]@users.noreply.github.com>');
  }, 30_000);

  it('lets the agent clone, push and open pull requests with the github tool', async () => {
    const ctx = { runtime: rt, cwd: root, signal: new AbortController().signal } as never;
    const cloned = await githubTool.execute({ action: 'clone', repo: 'acme/widgets', path: join(root, 'work', 'widgets') }, ctx);
    expect(cloned.isError).toBeFalsy();
    const dir = join(root, 'work', 'widgets');
    git(dir, 'checkout', '-q', '-b', 'docs/usage');
    writeFileSync(join(dir, 'USAGE.md'), 'use it\n');
    git(dir, 'add', '.');
    execFileSync('git', ['commit', '-q', '-m', 'Add usage'], { cwd: dir });
    const pushed = await githubTool.execute({ action: 'push', path: dir }, ctx);
    expect(pushed.content).toMatch(/Pushed docs\/usage to acme\/widgets/);
    const before = calls.length;
    const pr = await githubTool.execute({ action: 'create_pr', path: dir, title: 'Add usage docs', body: 'Explains usage.' }, ctx);
    expect(pr.content).toBe('Opened pull request #12: https://github.com/acme/widgets/pull/12');
    const sent = calls.slice(before).find((c) => c.path === '/repos/acme/widgets/pulls');
    expect(sent?.body).toMatchObject({ head: 'docs/usage', base: 'main', title: 'Add usage docs' });
    // a PR from the base branch is refused with a hint
    git(dir, 'checkout', '-q', 'main');
    expect((await githubTool.execute({ action: 'create_pr', path: dir, title: 'x' }, ctx)).content).toMatch(/feature branch/);
    // the agent's own `git push` is authenticated for GitHub checkouts
    expect(await rt.github.shellEnv(dir)).toMatchObject({ GIT_CONFIG_KEY_0: expect.stringContaining('.extraheader'), GIT_CONFIG_VALUE_0: expect.stringMatching(/^AUTHORIZATION: basic /) });
    expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).not.toContain('ghs_installation');
  });

  it('clones a repository and starts a chat in it from the app', async () => {
    const r = await (await authed('/api/github/clone', { method: 'POST', body: JSON.stringify({ repo: 'acme/widgets' }) })).json();
    expect(r.path).toBe(join(rt.paths.root, 'repos', 'acme', 'widgets'));
    expect(existsSync(join(r.path, 'README.md'))).toBe(true);
    expect(rt.sessions.get(r.session.id)?.cwd).toBe(r.path);
  });
});
