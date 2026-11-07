/**
 * Embedded opencode engine.
 *
 * Kronos bundles the open-source opencode CLI (https://opencode.ai, Apache/MIT) as a background
 * engine so the desktop app can use opencode Zen's models with no provider sign-in. This manager:
 *
 *   • finds an existing `opencode` binary, or installs one silently into the Kronos home;
 *   • discovers the Zen credential opencode stores on disk and exports it as OPENCODE_API_KEY,
 *     so the `opencode` provider (an OpenAI-compatible client of the Zen endpoint) is authenticated
 *     without the user ever touching a provider screen;
 *   • optionally runs `opencode serve` in the background.
 *
 * Everything here is best-effort and never throws into the host: if opencode cannot be installed
 * or started, Kronos still runs — the `opencode` provider falls back to whatever Zen offers
 * keyless, and the user can pick another model. opencode remains an implementation detail; the UI
 * only ever shows Kronos branding.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { which, runShell, runProcess } from '../util/process.js';
import { logger } from '../util/log.js';

const log = logger('opencode');

const IS_WIN = platform() === 'win32';

export interface OpencodeOptions {
  /** base directory for the managed install, logs and the server working dir */
  home: string;
  /** also run `opencode serve` in the background (default false) */
  serve?: boolean;
  /** port for `opencode serve` (default 4096) */
  port?: number;
  /** download + install opencode when no binary is found (default true) */
  autoInstall?: boolean;
  /** environment-variable name the Zen credential is exported under (default OPENCODE_API_KEY) */
  tokenEnv?: string;
}

export interface OpencodeStatus {
  installed: boolean;
  binary?: string;
  serving: boolean;
  serverUrl?: string;
  /** a Zen credential was found on disk and exported to the environment */
  authed: boolean;
}

/** Candidate paths where opencode stores its auth/credentials file across platforms. */
function authStoreCandidates(): string[] {
  const home = homedir();
  const out: string[] = [];
  if (process.env.XDG_DATA_HOME) out.push(join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'));
  out.push(join(home, '.local', 'share', 'opencode', 'auth.json'));
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'opencode', 'auth.json'));
  out.push(join(home, '.config', 'opencode', 'auth.json'));
  out.push(join(home, 'Library', 'Application Support', 'opencode', 'auth.json'));
  out.push(join(home, '.opencode', 'auth.json'));
  return out;
}

/**
 * Pull a bearer-style credential for Zen out of opencode's auth store. The file shape has changed
 * across opencode versions, so this walks the JSON for the `opencode`/`zen` entry and accepts any
 * of the key/token field names opencode has used.
 */
function extractZenToken(authJson: unknown): string | undefined {
  if (!authJson || typeof authJson !== 'object') return undefined;
  const record = authJson as Record<string, unknown>;
  const pickFrom = (v: unknown): string | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    for (const field of ['apiKey', 'api_key', 'key', 'token', 'access', 'accessToken', 'access_token']) {
      const val = o[field];
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return undefined;
  };
  // preferred: a provider entry keyed by opencode/zen
  for (const name of ['opencode', 'zen', 'opencode-zen']) {
    const direct = pickFrom(record[name]);
    if (direct) return direct;
  }
  // otherwise: the first entry that looks like it belongs to Zen
  for (const [name, value] of Object.entries(record)) {
    if (/opencode|zen/i.test(name)) {
      const t = pickFrom(value);
      if (t) return t;
    }
  }
  return undefined;
}

export class OpencodeManager {
  private child: ChildProcess | null = null;
  private binary: string | undefined;
  private port: number;
  private tokenEnv: string;
  private installing: Promise<string | undefined> | null = null;

  constructor(private readonly opts: OpencodeOptions) {
    this.port = opts.port ?? 4096;
    this.tokenEnv = opts.tokenEnv ?? 'OPENCODE_API_KEY';
  }

  /** Directory that holds the managed binary (and where the installer is told to write). */
  private installDir(): string {
    return join(this.opts.home, 'opencode');
  }

  private managedBinary(): string {
    return join(this.installDir(), 'bin', IS_WIN ? 'opencode.exe' : 'opencode');
  }

  /** Locate an opencode binary: a previous managed install first, then one already on PATH. */
  async locate(): Promise<string | undefined> {
    if (this.binary && existsSync(this.binary)) return this.binary;
    const managed = this.managedBinary();
    if (existsSync(managed)) return (this.binary = managed);
    const onPath = await which('opencode');
    if (onPath) return (this.binary = onPath);
    return undefined;
  }

  /**
   * Install opencode into the Kronos home using the official installer, falling back to npm.
   * Serialised so concurrent callers share one install. Returns the binary path, or undefined.
   */
  async install(): Promise<string | undefined> {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      const dir = this.installDir();
      mkdirSync(join(dir, 'bin'), { recursive: true });
      const env = { ...process.env, OPENCODE_INSTALL_DIR: dir, OPENCODE_DISABLE_AUTOUPDATE: '1' };
      const attempts: { label: string; cmd: string }[] = IS_WIN
        ? [
            { label: 'official installer', cmd: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://opencode.ai/install.ps1 | iex"' },
            { label: 'npm', cmd: `npm install --prefix "${dir}" opencode-ai` },
          ]
        : [
            { label: 'official installer', cmd: 'curl -fsSL https://opencode.ai/install | bash' },
            { label: 'npm', cmd: `npm install --prefix "${dir}" opencode-ai` },
          ];
      for (const a of attempts) {
        try {
          log.info(`installing opencode via ${a.label}`);
          const r = await runShell(a.cmd, { env, timeoutMs: 180_000 });
          if (r.exitCode === 0) {
            // installer writes to <dir>/bin; npm writes to <dir>/node_modules/.bin
            const npmBin = join(dir, 'node_modules', '.bin', IS_WIN ? 'opencode.cmd' : 'opencode');
            const found = [this.managedBinary(), npmBin].find((p) => existsSync(p)) ?? (await which('opencode')) ?? undefined;
            if (found) {
              log.info(`opencode installed at ${found}`);
              return (this.binary = found);
            }
          }
          log.warn(`opencode install via ${a.label} did not produce a binary (exit ${r.exitCode})`);
        } catch (e) {
          log.warn(`opencode install via ${a.label} failed`, e);
        }
      }
      log.warn('could not install opencode; Kronos will use the Zen endpoint directly if a credential is available');
      return undefined;
    })().finally(() => (this.installing = null));
    return this.installing;
  }

  /** Ensure a binary exists (install when missing and allowed). */
  async ensureInstalled(): Promise<string | undefined> {
    const found = await this.locate();
    if (found) return found;
    if (this.opts.autoInstall === false) return undefined;
    return this.install();
  }

  /**
   * Read opencode's stored Zen credential and export it so the `opencode` provider authenticates
   * to the Zen endpoint. Does nothing (and does not overwrite) if a credential is already set in
   * the environment. Returns true when a credential is now present.
   */
  discoverToken(): boolean {
    if (process.env[this.tokenEnv]) return true;
    for (const file of authStoreCandidates()) {
      if (!existsSync(file)) continue;
      try {
        const token = extractZenToken(JSON.parse(readFileSync(file, 'utf8')));
        if (token) {
          process.env[this.tokenEnv] = token;
          log.info(`using opencode Zen credential from ${file}`);
          return true;
        }
      } catch (e) {
        log.debug(`could not read opencode auth store ${file}`, e);
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // model sync — keep the Kronos picker in step with what opencode offers

  /** opencode config files that may declare providers/models, most specific last. */
  private opencodeConfigFiles(): string[] {
    const home = homedir();
    const out: string[] = [];
    if (process.env.XDG_CONFIG_HOME) out.push(join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'));
    out.push(join(home, '.config', 'opencode', 'opencode.json'));
    if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'opencode', 'opencode.json'));
    out.push(join(home, '.opencode', 'opencode.json'));
    return out;
  }

  /**
   * Models opencode knows about from its own config — the selected `model` plus any `provider.*.models`.
   * Model refs are `provider/model`; only the model part is returned (the Kronos `opencode` provider
   * talks to the Zen endpoint). The live Zen catalog is fetched separately by the provider.
   */
  configuredModels(): { models: string[]; default?: string } {
    const models = new Set<string>();
    let def: string | undefined;
    const bare = (ref: unknown): string | undefined => (typeof ref === 'string' && ref.trim() ? (ref.includes('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref.trim()) : undefined);
    for (const file of this.opencodeConfigFiles()) {
      if (!existsSync(file)) continue;
      try {
        const cfg = JSON.parse(readFileSync(file, 'utf8')) as { model?: unknown; provider?: Record<string, { models?: unknown }> };
        const d = bare(cfg.model);
        if (d) {
          def ??= d;
          models.add(d);
        }
        for (const p of Object.values(cfg.provider ?? {})) {
          const list = p?.models;
          if (Array.isArray(list)) for (const m of list) { const b = bare(m); if (b) models.add(b); }
          else if (list && typeof list === 'object') for (const k of Object.keys(list)) { const b = bare(k); if (b) models.add(b); }
        }
      } catch (e) {
        log.debug(`could not read opencode config ${file}`, e);
      }
    }
    return { models: [...models], default: def };
  }

  private watchers: FSWatcher[] = [];

  /** Watch opencode's config for model changes; calls `onChange` (debounced) when it changes. */
  watchConfig(onChange: () => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 400);
      timer.unref?.();
    };
    for (const file of this.opencodeConfigFiles()) {
      const dir = dirname(file);
      if (!existsSync(dir)) continue;
      try {
        const w = watch(dir, { persistent: false }, (_e, name) => {
          if (!name || String(name).includes('opencode.json')) fire();
        });
        this.watchers.push(w);
      } catch (e) {
        log.debug(`could not watch opencode config dir ${dir}`, e);
      }
    }
    return () => {
      clearTimeout(timer);
      for (const w of this.watchers.splice(0)) w.close();
    };
  }

  // ---------------------------------------------------------------------------------------------
  // updates — never silent; the host asks the user before applying one

  /** The installed opencode version, if a binary is available. */
  async version(): Promise<string | undefined> {
    const bin = await this.locate();
    if (!bin) return undefined;
    try {
      const r = await runProcess(bin, ['--version'], { timeoutMs: 15_000 });
      const m = /\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*/.exec(r.stdout || r.output);
      return m?.[0] ?? ((r.stdout || '').trim() || undefined);
    } catch (e) {
      log.debug('opencode --version failed', e);
      return undefined;
    }
  }

  /**
   * Check whether a newer opencode is available, best-effort via `opencode upgrade --check`.
   * Auto-update is disabled (OPENCODE_DISABLE_AUTOUPDATE), so nothing is changed here — the host
   * decides whether to call `update()`. When availability can't be determined, reports none.
   */
  async checkForUpdate(): Promise<{ current?: string; latest?: string; updateAvailable: boolean }> {
    const current = await this.version();
    const bin = await this.locate();
    if (!bin) return { current, updateAvailable: false };
    try {
      const r = await runProcess(bin, ['upgrade', '--check'], { timeoutMs: 30_000 });
      const text = `${r.stdout}\n${r.stderr}`;
      const latest = /(?:latest|available|new version)[^\d]*(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)/i.exec(text)?.[1] ?? /\bv?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)\b/.exec(text)?.[1];
      const upToDate = /up[- ]?to[- ]?date|already.*latest|no update/i.test(text);
      const updateAvailable = Boolean(latest && current && latest !== current) || (!upToDate && /available|new version/i.test(text));
      return { current, latest, updateAvailable };
    } catch (e) {
      log.debug('opencode upgrade --check failed', e);
      return { current, updateAvailable: false };
    }
  }

  /** Apply an opencode upgrade. Stops/restarts the background server around it. Returns the new version. */
  async update(): Promise<{ ok: boolean; version?: string }> {
    const bin = await this.locate();
    if (!bin) return { ok: false };
    const wasServing = Boolean(this.child && !this.child.killed);
    await this.stop();
    let ok = false;
    try {
      const r = await runProcess(bin, ['upgrade'], { timeoutMs: 180_000, env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' } });
      ok = r.exitCode === 0;
      if (!ok) log.warn(`opencode upgrade exited ${r.exitCode}: ${(r.stderr || r.output).slice(0, 300)}`);
    } catch (e) {
      log.warn('opencode upgrade failed', e);
    }
    if (wasServing) await this.startServe();
    return { ok, version: await this.version() };
  }

  /** Start `opencode serve` in the background. No-op if already running or no binary is available. */
  async startServe(): Promise<string | undefined> {
    if (this.child && !this.child.killed) return this.serverUrl();
    const bin = await this.ensureInstalled();
    if (!bin) return undefined;
    mkdirSync(join(this.opts.home, 'opencode', 'logs'), { recursive: true });
    const logFile = join(this.opts.home, 'opencode', 'logs', 'serve.log');
    const out = createWriteStream(logFile, { flags: 'a' });
    const env = { ...process.env, PATH: `${join(this.installDir(), 'bin')}${delimiter}${process.env.PATH ?? ''}` };
    try {
      const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(this.port)], {
        env,
        cwd: this.opts.home,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout?.pipe(out);
      child.stderr?.pipe(out);
      child.on('exit', (code) => {
        log.warn(`opencode serve exited (${code})`);
        if (this.child === child) this.child = null;
      });
      child.on('error', (e) => log.warn('opencode serve error', e));
      this.child = child;
      log.info(`opencode serve started on ${this.serverUrl()} (logs: ${logFile})`);
      return this.serverUrl();
    } catch (e) {
      log.warn('failed to start opencode serve', e);
      return undefined;
    }
  }

  serverUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Full startup: install (if needed), export the Zen credential, and optionally serve.
   * Never throws; returns the resulting status.
   */
  async start(): Promise<OpencodeStatus> {
    const bin = await this.ensureInstalled().catch(() => undefined);
    const authed = this.discoverToken();
    let serving = false;
    if (this.opts.serve) serving = Boolean(await this.startServe().catch(() => undefined));
    return { installed: Boolean(bin), binary: bin, serving, serverUrl: serving ? this.serverUrl() : undefined, authed };
  }

  status(): OpencodeStatus {
    return {
      installed: Boolean(this.binary),
      binary: this.binary,
      serving: Boolean(this.child && !this.child.killed),
      serverUrl: this.child && !this.child.killed ? this.serverUrl() : undefined,
      authed: Boolean(process.env[this.tokenEnv]),
    };
  }

  /** Stop the background server, if any. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
