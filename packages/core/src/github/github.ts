import { createSign, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kronos } from '../runtime.js';
import { runProcess } from '../util/process.js';
import { logger } from '../util/log.js';

const log = logger('github');

/**
 * GitHub for Kronos: who we are on GitHub, tokens for a repository, the REST API, and git with
 * credentials. Two ways to be connected, usable together:
 *
 * - a personal token (`github.token` / `GITHUB_TOKEN`, or the GitHub CLI's `gh auth token`): the
 *   agent acts as the user;
 * - the Kronos **GitHub App** (created in one click from a manifest, then installed on chosen
 *   repositories): the agent acts as `<app>[bot]` with short-lived installation tokens scoped to
 *   those repositories, and can answer `@kronos` mentions through webhooks.
 *
 * Tokens never touch disk or a command line: git gets them as an `http.extraheader` through
 * `GIT_CONFIG_*` environment variables, per command.
 */

export interface GitHubAppCredentials {
  id: number;
  slug: string;
  name: string;
  owner: string;
  htmlUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  pem: string;
  createdAt: number;
}

export interface GitHubRepo {
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  updatedAt: string;
  htmlUrl: string;
  via: 'app' | 'user';
}

export interface GitHubStatus {
  connected: boolean;
  user?: { login: string; name?: string; avatarUrl?: string; source: 'token' | 'gh' };
  app?: { slug: string; name: string; htmlUrl: string; installUrl: string; installations: { id: number; account: string; repositories: 'all' | 'selected' }[]; webhook: boolean };
  error?: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

type TokenKind = 'app' | 'user';

/** owner/repo from an https, ssh or git remote URL of a GitHub host. */
export function parseGitHubRemote(url: string, host = 'github.com'): { owner: string; repo: string } | undefined {
  const h = host.replace(/[.]/g, '\\.');
  const m = new RegExp(`^(?:https?://(?:[^@/]+@)?${h}/|git@${h}:|ssh://git@${h}/|git://${h}/)([^/]+)/([^/]+?)(?:\\.git)?/?$`).exec(url.trim());
  return m ? { owner: m[1] as string, repo: m[2] as string } : undefined;
}

function base64url(s: string | Buffer): string {
  return Buffer.from(s).toString('base64url');
}

export class GitHubService {
  private appCache?: GitHubAppCredentials | null;
  private ghToken?: Promise<string | undefined>;
  private installTokens = new Map<number, { token: string; expiresAt: number }>();
  private repoInstall = new Map<string, { id: number | null; at: number }>();
  private identities = new Map<string, { name: string; email: string }>();
  private manifestStates = new Map<string, number>();

  constructor(private readonly rt: Kronos) {}

  private get cfg() {
    return this.rt.config.github;
  }

  private get host(): string {
    try {
      return new URL(this.cfg.webUrl).host || 'github.com';
    } catch {
      return 'github.com';
    }
  }

  // ------------------------------------------------------------------------------- credentials

  private appFile(): string {
    return join(this.rt.paths.root, 'github-app.json');
  }

  app(): GitHubAppCredentials | undefined {
    if (this.appCache === undefined) {
      try {
        this.appCache = existsSync(this.appFile()) ? (JSON.parse(readFileSync(this.appFile(), 'utf8')) as GitHubAppCredentials) : null;
      } catch (e) {
        log.warn('unreadable github-app.json', e);
        this.appCache = null;
      }
    }
    return this.appCache ?? undefined;
  }

  saveApp(creds: GitHubAppCredentials): void {
    mkdirSync(this.rt.paths.root, { recursive: true });
    writeFileSync(this.appFile(), JSON.stringify(creds, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.appFile(), 0o600);
    } catch {
      /* best effort on filesystems without modes */
    }
    this.appCache = creds;
    this.installTokens.clear();
    this.repoInstall.clear();
  }

  removeApp(): void {
    rmSync(this.appFile(), { force: true });
    this.appCache = null;
    this.installTokens.clear();
    this.repoInstall.clear();
  }

  /** The user's token: `github.token` (GITHUB_TOKEN), else the GitHub CLI's. */
  async userToken(): Promise<{ token: string; source: 'token' | 'gh' } | undefined> {
    const t = this.cfg.token?.trim();
    if (t && !t.startsWith('${')) return { token: t, source: 'token' };
    this.ghToken ??= runProcess('gh', ['auth', 'token', '--hostname', this.host], { timeoutMs: 5000 })
      .then((r) => (r.exitCode === 0 ? r.stdout.trim() || undefined : undefined))
      .catch(() => undefined);
    const gh = await this.ghToken;
    return gh ? { token: gh, source: 'gh' } : undefined;
  }

  /** Forget a cached `gh` token (after logging in or out there). */
  resetCache(): void {
    this.ghToken = undefined;
    this.identities.clear();
  }

  /** JWT that authenticates as the app itself (10 minutes max; we use 9). */
  appJwt(): string {
    const app = this.app();
    if (!app) throw new GitHubError('The Kronos GitHub App is not set up.', 401);
    const now = Math.floor(Date.now() / 1000);
    const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(app.id) }));
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(app.pem);
    return `${head}.${body}.${base64url(sig)}`;
  }

  async installationToken(installationId: number): Promise<string> {
    const hit = this.installTokens.get(installationId);
    if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;
    const r = await this.request<{ token: string; expires_at: string }>('POST', `/app/installations/${installationId}/access_tokens`, undefined, { jwt: true });
    this.installTokens.set(installationId, { token: r.token, expiresAt: Date.parse(r.expires_at) });
    return r.token;
  }

  /** The app installation that covers owner/repo, if any (cached for 10 minutes). */
  async installationFor(fullName: string): Promise<number | undefined> {
    if (!this.app()) return undefined;
    const key = fullName.toLowerCase();
    const hit = this.repoInstall.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id ?? undefined;
    let id: number | null = null;
    try {
      id = (await this.request<{ id: number }>('GET', `/repos/${fullName}/installation`, undefined, { jwt: true })).id;
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 404)) throw e;
    }
    this.repoInstall.set(key, { id, at: Date.now() });
    return id ?? undefined;
  }

  /** A token that can act on `fullName`: the app's installation token when installed there, else the user's. */
  async tokenFor(fullName?: string, prefer: TokenKind = 'app'): Promise<{ token: string; kind: TokenKind }> {
    if (fullName && prefer === 'app') {
      const inst = await this.installationFor(fullName).catch(() => undefined);
      if (inst) return { token: await this.installationToken(inst), kind: 'app' };
    }
    const user = await this.userToken();
    if (user) return { token: user.token, kind: 'user' };
    if (fullName && prefer === 'user') {
      const inst = await this.installationFor(fullName).catch(() => undefined);
      if (inst) return { token: await this.installationToken(inst), kind: 'app' };
    }
    throw new GitHubError(
      fullName && this.app()
        ? `The Kronos GitHub App is not installed on ${fullName} and no personal token is set. Install the app on it (Settings → GitHub) or add a token.`
        : 'GitHub is not connected. Connect it in Settings → GitHub (or set GITHUB_TOKEN, or log in with `gh auth login`).',
      401,
    );
  }

  // ---------------------------------------------------------------------------------------- API

  async request<T = unknown>(method: string, path: string, body?: unknown, auth: { token?: string; jwt?: boolean; repo?: string; accept?: string } = {}): Promise<T> {
    const token = auth.jwt ? this.appJwt() : (auth.token ?? (await this.tokenFor(auth.repo)).token);
    const url = path.startsWith('http') ? path : `${this.cfg.apiUrl.replace(/\/+$/, '')}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        accept: auth.accept ?? 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'KronosAgent',
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const d = data as { message?: string; errors?: { message?: string; field?: string; code?: string }[] } | undefined;
      const extra = d?.errors?.map((e) => e.message ?? `${e.field} ${e.code}`).join('; ');
      throw new GitHubError(`GitHub ${method} ${path} → ${res.status}: ${d?.message ?? text.slice(0, 300)}${extra ? ` (${extra})` : ''}`, res.status);
    }
    return data as T;
  }

  async status(): Promise<GitHubStatus> {
    const out: GitHubStatus = { connected: false };
    try {
      const user = await this.userToken();
      if (user) {
        const me = await this.request<{ login: string; name?: string; avatar_url?: string }>('GET', '/user', undefined, { token: user.token });
        out.user = { login: me.login, name: me.name ?? undefined, avatarUrl: me.avatar_url, source: user.source };
      }
    } catch (e) {
      out.error = (e as Error).message;
    }
    const app = this.app();
    if (app) {
      let installations: NonNullable<GitHubStatus['app']>['installations'] = [];
      let webhook = false;
      try {
        const list = await this.request<{ id: number; account: { login: string }; repository_selection: 'all' | 'selected' }[]>('GET', '/app/installations', undefined, { jwt: true });
        installations = list.map((i) => ({ id: i.id, account: i.account.login, repositories: i.repository_selection }));
        const hook = await this.request<{ url?: string }>('GET', '/app/hook/config', undefined, { jwt: true }).catch(() => ({ url: '' }));
        webhook = Boolean(hook.url && /^https?:\/\//.test(hook.url));
      } catch (e) {
        out.error = (e as Error).message;
      }
      out.app = { slug: app.slug, name: app.name, htmlUrl: app.htmlUrl, installUrl: `${this.cfg.webUrl.replace(/\/+$/, '')}/apps/${app.slug}/installations/new`, installations, webhook };
    }
    out.connected = Boolean(out.user || out.app?.installations.length);
    return out;
  }

  /** Repositories Kronos can work on: the app's installations plus the user's own. */
  async repos(query = ''): Promise<GitHubRepo[]> {
    const seen = new Map<string, GitHubRepo>();
    type ApiRepo = { full_name: string; private: boolean; description: string | null; default_branch: string; updated_at: string; html_url: string };
    const add = (r: ApiRepo, via: 'app' | 'user') => {
      if (!seen.has(r.full_name)) seen.set(r.full_name, { fullName: r.full_name, private: r.private, description: r.description ?? '', defaultBranch: r.default_branch, updatedAt: r.updated_at, htmlUrl: r.html_url, via });
    };
    if (this.app()) {
      const installs = await this.request<{ id: number }[]>('GET', '/app/installations', undefined, { jwt: true }).catch(() => []);
      for (const inst of installs) {
        const token = await this.installationToken(inst.id).catch(() => undefined);
        if (!token) continue;
        const r = await this.request<{ repositories: ApiRepo[] }>('GET', '/installation/repositories?per_page=100', undefined, { token }).catch(() => ({ repositories: [] }));
        for (const repo of r.repositories) add(repo, 'app');
      }
    }
    const user = await this.userToken();
    if (user) {
      const list = await this.request<ApiRepo[]>('GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', undefined, { token: user.token }).catch(() => []);
      for (const repo of list) add(repo, 'user');
    }
    const q = query.trim().toLowerCase();
    return [...seen.values()].filter((r) => !q || r.fullName.toLowerCase().includes(q)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Name and email for commits made with a token of this kind. */
  async identity(kind: TokenKind, token: string): Promise<{ name: string; email: string }> {
    const key = kind === 'app' ? `app:${this.app()?.slug}` : `user:${token.slice(-6)}`;
    const hit = this.identities.get(key);
    if (hit) return hit;
    let id: { name: string; email: string };
    if (kind === 'app') {
      const slug = this.app()?.slug ?? 'kronos';
      const bot = await this.request<{ id: number }>('GET', `/users/${encodeURIComponent(`${slug}[bot]`)}`, undefined, { token }).catch(() => ({ id: 0 }));
      id = { name: `${slug}[bot]`, email: `${bot.id ? `${bot.id}+` : ''}${slug}[bot]@users.noreply.github.com` };
    } else {
      const me = await this.request<{ id: number; login: string; name?: string | null }>('GET', '/user', undefined, { token });
      id = { name: me.name || me.login, email: `${me.id}+${me.login}@users.noreply.github.com` };
    }
    this.identities.set(key, id);
    return id;
  }

  // ---------------------------------------------------------------------------------------- git

  /** Environment that authenticates git against the GitHub host for one command. */
  gitAuthEnv(token: string): Record<string, string> {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${this.cfg.webUrl.replace(/\/+$/, '')}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  /** The GitHub repository a working tree belongs to (from `origin`). */
  async repoOf(cwd: string): Promise<string | undefined> {
    const r = await runProcess('git', ['remote', 'get-url', 'origin'], { cwd, timeoutMs: 5000 }).catch(() => undefined);
    if (!r || r.exitCode !== 0) return undefined;
    const url = r.stdout.trim();
    // anything under the configured web URL (also GitHub Enterprise paths), then the usual forms
    const web = this.cfg.webUrl.replace(/\/+$/, '');
    const under = url.startsWith(`${web}/`) ? /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.slice(web.length + 1)) : null;
    if (under) return `${under[1]}/${under[2]}`;
    const p = parseGitHubRemote(url, this.host);
    return p ? `${p.owner}/${p.repo}` : undefined;
  }

  /** Credentials for `git` run by the agent's shell in `cwd`, when it is a GitHub checkout. */
  async shellEnv(cwd: string): Promise<Record<string, string>> {
    if (!this.cfg.shellAuth) return {};
    try {
      const repo = await this.repoOf(cwd);
      if (!repo) return {};
      const { token } = await this.tokenFor(repo);
      return this.gitAuthEnv(token);
    } catch {
      return {};
    }
  }

  async git(args: string[], cwd: string, token?: string, timeoutMs = 300_000): Promise<{ ok: boolean; output: string }> {
    const r = await runProcess('git', args, { cwd, timeoutMs, env: token ? this.gitAuthEnv(token) : { GIT_TERMINAL_PROMPT: '0' } });
    return { ok: r.exitCode === 0, output: r.output.trim() };
  }

  reposDir(): string {
    return this.cfg.reposDir?.trim() || join(this.rt.paths.root, 'repos');
  }

  /** Clones (or updates) owner/repo and sets the commit identity for the token that cloned it. */
  async clone(fullName: string, opts: { dest?: string; branch?: string } = {}): Promise<{ path: string; updated: boolean; kind: TokenKind }> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new GitHubError(`"${fullName}" is not owner/repo`, 400);
    const { token, kind } = await this.tokenFor(fullName);
    const dest = opts.dest ?? join(this.reposDir(), fullName);
    let updated = false;
    if (existsSync(join(dest, '.git'))) {
      const f = await this.git(['fetch', '--prune', 'origin'], dest, token);
      if (!f.ok) throw new GitHubError(`git fetch failed: ${f.output}`, 500);
      updated = true;
    } else {
      mkdirSync(join(dest, '..'), { recursive: true });
      const url = `${this.cfg.webUrl.replace(/\/+$/, '')}/${fullName}.git`;
      const c = await this.git(['clone', ...(opts.branch ? ['--branch', opts.branch] : []), url, dest], join(dest, '..'), token, 900_000);
      if (!c.ok) throw new GitHubError(`git clone failed: ${c.output}`, 500);
    }
    if (opts.branch && updated) await this.git(['checkout', opts.branch], dest, token);
    const id = await this.identity(kind, token).catch(() => undefined);
    if (id) {
      await this.git(['config', 'user.name', id.name], dest);
      await this.git(['config', 'user.email', id.email], dest);
    }
    return { path: dest, updated, kind };
  }

  /** Pushes the current (or given) branch of the checkout at `cwd` and sets its upstream. */
  async push(cwd: string, branch?: string, force = false): Promise<{ repo: string; branch: string; output: string }> {
    const repo = await this.repoOf(cwd);
    if (!repo) throw new GitHubError('This directory is not a GitHub checkout (no GitHub origin remote).', 400);
    const b = branch ?? (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).output;
    if (!b || b === 'HEAD') throw new GitHubError('Not on a branch (detached HEAD): create a branch first.', 400);
    const { token } = await this.tokenFor(repo);
    const r = await this.git(['push', ...(force ? ['--force-with-lease'] : []), '-u', 'origin', b], cwd, token);
    if (!r.ok) throw new GitHubError(`git push failed: ${r.output}`, 500);
    return { repo, branch: b, output: r.output };
  }

  // ------------------------------------------------------------------------------- app creation

  /**
   * The manifest for creating the Kronos GitHub App in one click (GitHub's manifest flow). The UI
   * posts it to `action`; GitHub redirects back to `/hooks/github/app-created` with a code that
   * `completeManifest` exchanges for the app's credentials. `state` ties the redirect to this request.
   */
  createManifest(opts: { baseUrl: string; publicUrl?: string; org?: string; name?: string }): { action: string; manifest: Record<string, unknown>; state: string } {
    const base = opts.baseUrl.replace(/\/+$/, '');
    const pub = (opts.publicUrl || this.rt.config.gateway.publicUrl || '').replace(/\/+$/, '');
    const state = randomBytes(16).toString('hex');
    this.manifestStates.set(state, Date.now());
    for (const [s, at] of this.manifestStates) if (Date.now() - at > 60 * 60_000) this.manifestStates.delete(s);
    const manifest = {
      name: opts.name || `kronos-${randomBytes(3).toString('hex')}`,
      url: 'https://github.com/burkiuze/KronosAgent',
      description: 'Kronos Agent: reads issues and pull requests, makes changes, pushes branches and opens pull requests when asked.',
      hook_attributes: { url: `${pub || base}/hooks/github`, active: Boolean(pub) },
      redirect_url: `${base}/hooks/github/app-created`,
      setup_url: `${base}/hooks/github/installed`,
      callback_urls: [`${base}/hooks/github/installed`],
      setup_on_update: true,
      public: false,
      default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read', checks: 'read', statuses: 'read', actions: 'read' },
      default_events: ['issue_comment', 'issues', 'pull_request_review_comment', 'pull_request_review'],
    };
    const web = this.cfg.webUrl.replace(/\/+$/, '');
    const action = `${web}/${opts.org ? `organizations/${encodeURIComponent(opts.org)}/` : ''}settings/apps/new?state=${state}`;
    return { action, manifest, state };
  }

  async completeManifest(code: string, state: string): Promise<GitHubAppCredentials> {
    if (!this.manifestStates.delete(state)) throw new GitHubError('Unknown or expired setup request — start "Create the GitHub App" again.', 400);
    const res = await fetch(`${this.cfg.apiUrl.replace(/\/+$/, '')}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'KronosAgent' },
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new GitHubError(`Creating the app failed: ${String(j.message ?? res.status)}`, res.status);
    const creds: GitHubAppCredentials = {
      id: Number(j.id),
      slug: String(j.slug),
      name: String(j.name),
      owner: String((j.owner as { login?: string } | undefined)?.login ?? ''),
      htmlUrl: String(j.html_url),
      clientId: String(j.client_id),
      clientSecret: String(j.client_secret),
      webhookSecret: String(j.webhook_secret ?? ''),
      pem: String(j.pem),
      createdAt: Date.now(),
    };
    this.saveApp(creds);
    return creds;
  }
}
