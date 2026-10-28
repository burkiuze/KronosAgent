import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Kronos } from '../runtime.js';
import { updateDotenv } from '../util/env.js';
import { logger } from '../util/log.js';

const log = logger('account');

/**
 * The Kronos account: sign-in to heynavio.com, membership and Kronos Cloud.
 *
 * Signing in is a browser round trip with PKCE: Kronos opens
 * `<cloud>/kronosagent/connect` with a random state and a code challenge, the person signs in (or
 * creates an account) there and approves, and the browser brings a one-time code back to
 * Kronos's callback. Kronos trades it, with the verifier only it knows, for an app token kept in
 * `~/.kronos/.env` as KRONOS_CLOUD_TOKEN (like an API key). The plan, usage and model list are
 * cached in `~/.kronos/account.json` so the app shows them offline.
 *
 * An account is optional: "continue without an account" is remembered, and Kronos works with
 * the person's own API keys. Kronos Cloud models are listed for everyone and locked without a
 * membership.
 */

export const CLOUD_PROVIDER = 'cloud';
export const CLOUD_TOKEN_ENV = 'KRONOS_CLOUD_TOKEN';
export const DEFAULT_CLOUD_URL = 'https://www.heynavio.com';

/**
 * heynavio.com answers on www and redirects the bare domain there. A redirect to another host
 * drops the Authorization header, so app requests would arrive signed out: always talk to www.
 */
function canonicalCloudUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/^https:\/\/heynavio\.com(?=\/|$)/i, 'https://www.heynavio.com');
}

export interface CloudModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  description?: string;
}

export interface UsageWindowView {
  spentMicro: number;
  limitMicro: number;
  percent: number;
  resetsAt: string | null;
}

export interface CloudAccount {
  email: string | null;
  plan: { id: string; name: string } | null;
  planExpiresAt: string | null;
  usage: { fiveHour: UsageWindowView; week: UsageWindowView };
}

export interface CloudPlan {
  id: string;
  name: string;
  multiplier: number;
  description: string;
}

export interface AccountStatus {
  signedIn: boolean;
  /** chose "continue without an account" */
  skipped: boolean;
  /** signed in or skipped: the first-run screen is done */
  onboarded: boolean;
  account: CloudAccount | null;
  models: CloudModel[];
  plans: CloudPlan[];
  cloudUrl: string;
  checkedAt: number | null;
  error?: string;
}

interface CacheFile {
  skipped?: boolean;
  account?: CloudAccount | null;
  models?: CloudModel[];
  plans?: CloudPlan[];
  checkedAt?: number;
}

/** Listed before the first sign-in, so the models show (locked) to everyone. */
export const DEFAULT_CLOUD_MODELS: CloudModel[] = [
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', provider: 'Open Inference', contextWindow: 262_144, maxOutput: 32_768, vision: false, description: 'Fast coding and long agent runs.' },
  { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', provider: 'Nebius Token Factory', contextWindow: 262_144, maxOutput: 32_768, vision: false, description: 'Strong tool use at a low price per task.' },
  { id: 'nemotron-3.5-super-vl', name: 'Nemotron 3.5 Super VL', provider: 'Crusoe', contextWindow: 262_144, maxOutput: 32_768, vision: true, description: 'Reads screenshots, diagrams and documents.' },
  { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017', provider: 'Wafer', contextWindow: 262_144, maxOutput: 32_768, vision: false, description: 'Reasoning and code at flash speed.' },
];

export const DEFAULT_PLANS: CloudPlan[] = [
  { id: 'lite', name: 'Lite', multiplier: 0.5, description: 'For trying Kronos Cloud on everyday tasks.' },
  { id: 'pro', name: 'Pro', multiplier: 1, description: 'For daily work with the agent.' },
  { id: 'max', name: 'Max', multiplier: 2, description: '2× the usage of Pro, for long agent sessions.' },
  { id: 'max5', name: 'Max 5', multiplier: 5, description: '5× the usage of Pro, for running Kronos all day.' },
];

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

const b64url = (b: Buffer) => b.toString('base64url');
const PENDING_TTL_MS = 15 * 60_000;

export class AccountService {
  private pending = new Map<string, { verifier: string; redirectUri: string; at: number }>();
  private refreshing?: Promise<AccountStatus>;

  constructor(private k: Kronos) {}

  private get file(): string {
    return join(this.k.home, 'account.json');
  }

  private get envFile(): string {
    return join(this.k.home, '.env');
  }

  cloudUrl(): string {
    return canonicalCloudUrl(process.env.KRONOS_CLOUD_URL || this.k.config.cloud?.url || DEFAULT_CLOUD_URL);
  }

  /** Base URL of the OpenAI-compatible Kronos Cloud API. */
  apiBase(): string {
    return `${this.cloudUrl()}/api/kronos/v1`;
  }

  token(): string | undefined {
    return process.env[CLOUD_TOKEN_ENV]?.trim() || undefined;
  }

  private read(): CacheFile {
    try {
      return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as CacheFile) : {};
    } catch {
      return {};
    }
  }

  private write(patch: Partial<CacheFile>): void {
    writeFileSync(this.file, `${JSON.stringify({ ...this.read(), ...patch }, null, 2)}\n`, { mode: 0o600 });
  }

  status(): AccountStatus {
    const c = this.read();
    const signedIn = Boolean(this.token());
    return {
      signedIn,
      skipped: Boolean(c.skipped),
      onboarded: signedIn || Boolean(c.skipped),
      account: signedIn ? (c.account ?? null) : null,
      models: c.models?.length ? c.models : DEFAULT_CLOUD_MODELS,
      plans: c.plans?.length ? c.plans : DEFAULT_PLANS,
      cloudUrl: this.cloudUrl(),
      checkedAt: signedIn ? (c.checkedAt ?? null) : null,
    };
  }

  /** What the model registry needs to know: Kronos Cloud models run only for members. */
  access(): { signedIn: boolean; member: boolean } {
    const s = this.status();
    const expired = s.account?.planExpiresAt ? Date.parse(s.account.planExpiresAt) < Date.now() : false;
    return { signedIn: s.signedIn, member: Boolean(s.signedIn && s.account?.plan && !expired) };
  }

  /**
   * First half of signing in: the address to open in a browser. `redirectUri` is where the browser
   * returns (the gateway's /api/account/callback, or the CLI's temporary listener).
   */
  startLogin(redirectUri: string, opts: { mode?: 'sign-in' | 'sign-up'; client?: string } = {}): { url: string; state: string } {
    const now = Date.now();
    for (const [s, p] of this.pending) if (now - p.at > PENDING_TTL_MS) this.pending.delete(s);
    const state = b64url(randomBytes(18));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    this.pending.set(state, { verifier, redirectUri, at: now });
    const q = new URLSearchParams({
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      client: opts.client ?? `Kronos on ${hostname()}`,
      ...(opts.mode === 'sign-up' ? { mode: 'sign-up' } : {}),
    });
    return { url: `${this.cloudUrl()}/kronosagent/connect?${q.toString()}`, state };
  }

  /** Second half: trade the code from the browser for an app token. */
  async completeLogin(code: string, state: string): Promise<AccountStatus> {
    const p = this.pending.get(state);
    if (!p || Date.now() - p.at > PENDING_TTL_MS) throw new AccountError('This sign-in has expired. Start it again from Kronos.', 400, 'expired');
    this.pending.delete(state);
    const res = await this.request<{ token: string; account: CloudAccount; models?: CloudModel[] }>('/api/kronos/token', {
      method: 'POST',
      body: { code, code_verifier: p.verifier, redirect_uri: p.redirectUri, label: `Kronos on ${hostname()}` },
      auth: false,
    });
    updateDotenv(this.envFile, { [CLOUD_TOKEN_ENV]: res.token });
    process.env[CLOUD_TOKEN_ENV] = res.token;
    this.write({ skipped: false, account: res.account, ...(res.models?.length ? { models: res.models } : {}), checkedAt: Date.now() });
    this.k.reload();
    log.info(`signed in as ${res.account.email ?? 'unknown'}`);
    return this.status();
  }

  /** Plan and usage from the server; a token the server no longer accepts signs Kronos out. */
  async refresh(): Promise<AccountStatus> {
    if (!this.token()) return this.status();
    this.refreshing ??= (async () => {
      try {
        const me = await this.request<{ account: CloudAccount; models?: CloudModel[]; plans?: CloudPlan[] }>('/api/kronos/me');
        const before = this.access().member;
        this.write({ account: me.account, ...(me.models?.length ? { models: me.models } : {}), ...(me.plans?.length ? { plans: me.plans } : {}), checkedAt: Date.now() });
        if (this.access().member !== before) this.k.reload();
        return this.status();
      } catch (e) {
        if (e instanceof AccountError && e.status === 401) {
          this.forget();
          return { ...this.status(), error: 'Your Kronos sign-in has ended. Sign in again.' };
        }
        return { ...this.status(), error: (e as Error).message };
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  async redeem(code: string): Promise<AccountStatus> {
    if (!this.token()) throw new AccountError('Sign in to redeem a promo code.', 401);
    const r = await this.request<{ account: CloudAccount }>('/api/kronos/redeem', { method: 'POST', body: { code: code.trim() } });
    this.write({ account: r.account, checkedAt: Date.now() });
    this.k.reload();
    return this.status();
  }

  async logout(): Promise<AccountStatus> {
    if (this.token()) await this.request('/api/kronos/logout', { method: 'POST' }).catch((e) => log.debug('remote sign-out failed', e));
    this.forget();
    return this.status();
  }

  /** "Continue without an account". */
  skip(): AccountStatus {
    this.write({ skipped: true });
    return this.status();
  }

  private forget(): void {
    updateDotenv(this.envFile, { [CLOUD_TOKEN_ENV]: null });
    delete process.env[CLOUD_TOKEN_ENV];
    this.write({ account: null, checkedAt: undefined });
    this.k.reload();
  }

  private async request<T>(path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false && this.token()) headers.authorization = `Bearer ${this.token()}`;
    let res: Response;
    try {
      res = await fetch(`${this.cloudUrl()}${path}`, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new AccountError(`Could not reach ${this.cloudUrl()}: ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } } & T;
    if (!res.ok) throw new AccountError(json.error?.message ?? `Kronos Cloud answered ${res.status}.`, res.status, json.error?.code);
    return json as T;
  }
}
