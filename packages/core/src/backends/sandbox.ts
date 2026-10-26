import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expandHome, kronosHome } from '../config/paths.js';

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
  /** when no sandbox is available: refuse to run commands, or run them unsandboxed */
  fallback: 'refuse' | 'unsandboxed';
}

export type SandboxEngine = 'kronos-sandbox' | 'bwrap' | 'seatbelt';

export interface WrappedCommand {
  file: string;
  args: string[];
  engine: SandboxEngine;
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
export function seatbeltProfile(writable: string[], network: boolean): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((_, i) => `(subpath (param "W${i}"))`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ptmx") (regex #"^/dev/ttys"))`,
    ...(network ? [] : ['(deny network-outbound (remote ip))', '(deny network-bind (local ip))']),
  ].join('\n');
}

/**
 * Prefix `file args` (usually `bash -c "<command>"`) with the sandbox. Returns an error when the
 * sandbox is on but unavailable (the caller refuses or falls back per `fallback`).
 */
export function wrapCommand(file: string, args: string[], cwd: string, cfg: SandboxConfig): WrappedCommand | { error: string } {
  const engine = detectSandbox();
  if ('error' in engine) return engine;
  const writable = writableRoots(cwd, cfg);
  switch (engine.engine) {
    case 'kronos-sandbox':
      return { engine: 'kronos-sandbox', file: engine.path, args: [...writable.flatMap((w) => ['--write', w]), ...(cfg.network ? [] : ['--no-network']), '--', file, ...args] };
    case 'bwrap':
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
      return { engine: 'seatbelt', file: engine.path, args: ['-p', seatbeltProfile(writable, cfg.network), ...writable.flatMap((w, i) => ['-D', `W${i}=${w}`]), '--', file, ...args] };
  }
}

/** One line for the system prompt and `kronos doctor`. */
export function describeSandbox(cfg: SandboxConfig | undefined): string {
  if (!cfg || cfg.mode === 'off') return '';
  const engine = detectSandbox();
  if ('error' in engine) return `sandbox ${cfg.mode} requested but unavailable — ${cfg.fallback === 'unsandboxed' ? 'commands run unsandboxed' : 'commands are refused'}`;
  return `sandboxed (${engine.detail}): ${cfg.mode === 'read-only' ? 'read-only except temp' : 'writes limited to the project and temp'}${cfg.network ? '' : ', no network'}`;
}
