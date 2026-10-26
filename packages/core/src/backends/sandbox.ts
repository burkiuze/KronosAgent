import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expandHome, kronosHome } from '../config/paths.js';
import { NetworkProxy, type DomainPolicy } from './netproxy.js';

/**
 * OS-level sandbox for commands on the local backend — the lightweight alternative to the Docker
 * backend (no daemon, no image, no extra memory). "workspace-write": everything is readable, only
 * the project, temp directories and `writable` can be changed. "read-only": nothing but temp.
 * `network: false` also cuts network access.
 *
 * Engines: Linux — the `kronos-sandbox` helper (Rust, Landlock + network namespace; built from
 * native/sandbox), else bubblewrap; macOS — sandbox-exec with a generated Seatbelt profile.
 */
export interface SandboxConfig {
  mode: 'off' | 'workspace-write' | 'read-only';
  network: boolean;
  /** extra writable directories (~ allowed) */
  writable: string[];
  /**
   * with network off: hosts still reachable through Kronos's filtering proxy ("registry.npmjs.org",
   * "**.github.com", …); empty = no network at all
   */
  allowDomains?: string[];
  /** when no sandbox is available: refuse to run commands, or run them unsandboxed */
  fallback: 'refuse' | 'unsandboxed';
}

export type SandboxEngine = 'kronos-sandbox' | 'bwrap' | 'seatbelt';

export interface WrappedCommand {
  file: string;
  args: string[];
  engine: SandboxEngine;
  /** environment the command needs (proxy settings) */
  env?: Record<string, string>;
}

let proxy: NetworkProxy | undefined;
let proxyReady: Promise<number> | undefined;
let proxyPolicy: DomainPolicy = { allow: [] };

/** Network through the allowlist proxy: network off, but some domains allowed. */
export function proxiedNetwork(cfg: SandboxConfig | undefined): boolean {
  return Boolean(cfg && cfg.mode !== 'off' && !cfg.network && cfg.allowDomains?.length);
}

/** Start (once) the filtering proxy for sandboxed commands; the policy follows the latest config. */
export async function ensureNetworkProxy(cfg: SandboxConfig): Promise<NetworkProxy> {
  proxyPolicy = { allow: cfg.allowDomains ?? [] };
  if (!proxy) {
    proxy = new NetworkProxy(() => proxyPolicy);
    proxyReady = proxy.start();
  }
  await proxyReady;
  return proxy;
}

/** The running proxy, if it has started. */
export function runningNetworkProxy(): NetworkProxy | undefined {
  return proxy && proxy.port ? proxy : undefined;
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, bin);
    if (dir && executable(p)) return p;
  }
  return undefined;
}

/** Where the helper may be: $KRONOS_SANDBOX_BIN, the source checkout's build, ~/.kronos/bin, PATH. */
export function sandboxHelperCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = [
    process.env.KRONOS_SANDBOX_BIN ?? '',
    resolve(here, '../../../../native/sandbox/target/release/kronos-sandbox'),
    join(kronosHome(), 'bin', 'kronos-sandbox'),
    onPath('kronos-sandbox') ?? '',
  ];
  return out.filter(Boolean);
}

let detected: { engine: SandboxEngine; path: string; detail: string } | { error: string } | undefined;

/** The best sandbox this machine offers (probed once). */
export function detectSandbox(refresh = false): { engine: SandboxEngine; path: string; detail: string } | { error: string } {
  if (detected && !refresh) return detected;
  if (process.platform === 'darwin') {
    detected = existsSync('/usr/bin/sandbox-exec') ? { engine: 'seatbelt', path: '/usr/bin/sandbox-exec', detail: 'macOS Seatbelt' } : { error: 'sandbox-exec is missing' };
    return detected;
  }
  if (process.platform !== 'linux') {
    detected = { error: `no OS sandbox on ${process.platform}; use the Docker backend (terminal.backend: docker)` };
    return detected;
  }
  const notes: string[] = [];
  for (const p of sandboxHelperCandidates()) {
    if (!executable(p)) continue;
    try {
      const probe = JSON.parse(execFileSync(p, ['--probe'], { encoding: 'utf8', timeout: 5000 })) as { landlock: number; userns: boolean };
      if (probe.landlock >= 1) {
        detected = { engine: 'kronos-sandbox', path: p, detail: `Landlock v${probe.landlock}${probe.landlock >= 4 ? ', network rules' : probe.userns ? ', network namespace' : ''}` };
        return detected;
      }
      notes.push('the kernel has no Landlock (5.13+ with landlock enabled)');
    } catch (e) {
      notes.push(`${p}: ${(e as Error).message.split('\n')[0]}`);
    }
    break;
  }
  const bwrap = onPath('bwrap');
  if (bwrap) {
    detected = { engine: 'bwrap', path: bwrap, detail: 'bubblewrap' };
    return detected;
  }
  detected = {
    error: `no sandbox available${notes.length ? ` (${notes.join('; ')})` : ''}: build the helper with \`cargo build --release --manifest-path native/sandbox/Cargo.toml\` (or put kronos-sandbox in ~/.kronos/bin), or install bubblewrap`,
  };
  return detected;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The project a command runs in: the enclosing git checkout, else the directory itself. */
export function projectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

/** Directories a sandboxed command may change. */
export function writableRoots(cwd: string, cfg: SandboxConfig): string[] {
  const roots = new Set<string>();
  if (cfg.mode === 'workspace-write') {
    roots.add(projectRoot(cwd));
    for (const w of cfg.writable) roots.add(resolve(cwd, expandHome(w)));
  }
  for (const t of [tmpdir(), '/tmp', '/var/tmp', process.env.TMPDIR ?? '']) if (t) roots.add(t);
  return [...roots].filter((p) => existsSync(p)).map(real);
}

/** Seatbelt profile: everything allowed except writes outside `writable` (and the network, if off). */
export function seatbeltProfile(writable: string[], network: boolean, proxyPort?: number): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((_, i) => `(subpath (param "W${i}"))`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ptmx") (regex #"^/dev/ttys"))`,
    ...(network ? [] : ['(deny network-outbound (remote ip))', '(deny network-bind (local ip))']),
    ...(!network && proxyPort ? [`(allow network-outbound (remote ip "localhost:${proxyPort}"))`] : []),
  ].join('\n');
}

/**
 * Prefix `file args` (usually `bash -c "<command>"`) with the sandbox. Returns an error when the
 * sandbox is on but unavailable (the caller refuses or falls back per `fallback`).
 */
export function wrapCommand(file: string, args: string[], cwd: string, cfg: SandboxConfig, proxyPort?: number): WrappedCommand | { error: string } {
  const engine = detectSandbox();
  if ('error' in engine) return engine;
  const writable = writableRoots(cwd, cfg);
  const proxied = proxiedNetwork(cfg);
  if (proxied && !proxyPort) return { error: 'the network proxy is not running' };
  const env = proxied && proxyPort ? { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, http_proxy: `http://127.0.0.1:${proxyPort}`, https_proxy: `http://127.0.0.1:${proxyPort}`, ALL_PROXY: `http://127.0.0.1:${proxyPort}`, all_proxy: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '', no_proxy: '' } : undefined;
  switch (engine.engine) {
    case 'kronos-sandbox':
      return {
        engine: 'kronos-sandbox',
        file: engine.path,
        args: [...writable.flatMap((w) => ['--write', w]), ...(cfg.network ? [] : proxied ? ['--allow-connect-port', String(proxyPort)] : ['--no-network']), '--', file, ...args],
        env,
      };
    case 'bwrap':
      if (proxied) return { error: 'bubblewrap cannot reach the network proxy from its isolated network; build the kronos-sandbox helper for terminal.sandbox.allowDomains' };
      return {
        engine: 'bwrap',
        file: engine.path,
        args: [
          '--ro-bind', '/', '/',
          '--dev-bind', '/dev', '/dev',
          '--proc', '/proc',
          '--unshare-pid',
          ...writable.flatMap((w) => ['--bind', w, w]),
          ...(cfg.network ? [] : ['--unshare-net']),
          '--die-with-parent',
          '--chdir', cwd,
          '--', file, ...args,
        ],
      };
    case 'seatbelt':
      return { engine: 'seatbelt', file: engine.path, args: ['-p', seatbeltProfile(writable, cfg.network, proxied ? proxyPort : undefined), ...writable.flatMap((w, i) => ['-D', `W${i}=${w}`]), '--', file, ...args], env };
  }
}

/** One line for the system prompt and `kronos doctor`. */
export function describeSandbox(cfg: SandboxConfig | undefined): string {
  if (!cfg || cfg.mode === 'off') return '';
  const engine = detectSandbox();
  if ('error' in engine) return `sandbox ${cfg.mode} requested but unavailable — ${cfg.fallback === 'unsandboxed' ? 'commands run unsandboxed' : 'commands are refused'}`;
  const net = cfg.network ? '' : proxiedNetwork(cfg) ? `, network only to ${cfg.allowDomains!.join(', ')} (through a proxy; set HTTPS_PROXY-aware tools)` : ', no network';
  return `sandboxed (${engine.detail}): ${cfg.mode === 'read-only' ? 'read-only except temp' : 'writes limited to the project and temp'}${net}`;
}
