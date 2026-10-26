import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { commandsOf } from './shellparse.js';
import { logger } from '../util/log.js';

const log = logger('osv');

/**
 * Malware check for packages the agent is about to install or run (after Hermes' osv_check, which
 * itself follows Goose): npm/pnpm/yarn/bun add|install, npx/bunx, pip/uv/pipx install, uvx are
 * looked up in the public OSV database and a package with a MAL-* advisory (confirmed malware,
 * typosquats) is refused. Ordinary CVEs are not blocked. Fail-open: when OSV cannot be reached
 * the command goes ahead. Verdicts are cached for an hour, also across restarts.
 */

export interface PackageRef {
  ecosystem: 'npm' | 'PyPI';
  name: string;
  version?: string;
}

export function parseNpmSpec(token: string): PackageRef | undefined {
  if (!token || /^[./~]|^(file|git|https?|link|workspace):/.test(token) || token.includes('/') && !token.startsWith('@')) return undefined;
  const m = token.startsWith('@') ? /^(@[^/]+\/[^@]+)(?:@(.+))?$/.exec(token) : /^([^@]+)(?:@(.+))?$/.exec(token);
  if (!m) return undefined;
  const version = m[2] && /^\d[\w.+-]*$/.test(m[2]) ? m[2] : undefined;
  return { ecosystem: 'npm', name: m[1] as string, version };
}

export function parsePypiSpec(token: string): PackageRef | undefined {
  if (!token || /^[./~]|:\/\/|\.whl$|\.tar\.gz$/.test(token)) return undefined;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?(?:==([\w.+-]+))?/.exec(token);
  return m ? { ecosystem: 'PyPI', name: (m[1] as string).toLowerCase(), version: m[2] } : undefined;
}

/** Packages a command line installs or runs from a registry. */
export function packagesInCommand(command: string): PackageRef[] {
  const out: PackageRef[] = [];
  const positional = (args: string[], valueFlags: RegExp = /^$/) => {
    const res: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (a.startsWith('-')) {
        if (valueFlags.test(a)) i++;
        continue;
      }
      res.push(a);
    }
    return res;
  };
  for (const words of commandsOf(command).commands) {
    const [cmd = '', sub = '', ...rest] = words.map((w, i) => (i === 0 ? w.replace(/^.*\//, '') : w));
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && ['install', 'i', 'add', 'in'].includes(sub)) {
      for (const t of positional(rest, /^(--registry|--prefix|-w|--workspace|--filter)$/)) {
        const p = parseNpmSpec(t);
        if (p) out.push(p);
      }
    } else if (['npx', 'bunx', 'pnpx'].includes(cmd)) {
      const args = [sub, ...rest];
      const explicit = args.findIndex((a) => a === '-p' || a === '--package');
      const pkg = explicit >= 0 ? args[explicit + 1] : args.find((a) => a && !a.startsWith('-'));
      const p = pkg ? parseNpmSpec(pkg.startsWith('--package=') ? pkg.slice(10) : pkg) : undefined;
      if (p) out.push(p);
    } else if ((cmd === 'pip' || cmd === 'pip3' || (cmd === 'uv' && sub === 'pip') || cmd === 'pipx') && (sub === 'install' || rest[0] === 'install')) {
      const args = cmd === 'uv' ? rest.slice(1) : rest;
      if (args.some((a) => a === '-r' || a === '--requirement')) continue;
      for (const t of positional(args, /^(-i|--index-url|--extra-index-url|-t|--target|-c|--constraint)$/)) {
        const p = parsePypiSpec(t);
        if (p) out.push(p);
      }
    } else if (cmd === 'uvx' || (cmd === 'uv' && sub === 'tool' && rest[0] === 'run')) {
      const args = cmd === 'uvx' ? [sub, ...rest] : rest.slice(1);
      const pkg = args.find((a) => a && !a.startsWith('-'));
      const p = pkg ? parsePypiSpec(pkg) : undefined;
      if (p) out.push(p);
    }
  }
  return out;
}

export interface MalwareHit {
  pkg: PackageRef;
  ids: string[];
  summary: string;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export class OsvChecker {
  private cache = new Map<string, { exp: number; hit: MalwareHit | null }>();
  private loaded = false;

  constructor(
    private cacheFile?: string,
    private fetchImpl: Fetch = fetch as unknown as Fetch,
    private endpoint = 'https://api.osv.dev/v1/query',
    private ttlMs = 3600_000,
  ) {}

  private load(): void {
    if (this.loaded || !this.cacheFile) return;
    this.loaded = true;
    try {
      if (!existsSync(this.cacheFile)) return;
      const data = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Record<string, { exp: number; hit: MalwareHit | null }>;
      for (const [k, v] of Object.entries(data)) if (v.exp > Date.now()) this.cache.set(k, v);
    } catch {
      /* a broken cache is just empty */
    }
  }

  private save(): void {
    if (!this.cacheFile) return;
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      const live = [...this.cache.entries()].filter(([, v]) => v.exp > Date.now()).slice(-256);
      writeFileSync(this.cacheFile, JSON.stringify(Object.fromEntries(live)));
    } catch {
      /* best effort */
    }
  }

  async check(pkg: PackageRef): Promise<MalwareHit | null> {
    this.load();
    const key = `${pkg.ecosystem}:${pkg.name}@${pkg.version ?? ''}`;
    const c = this.cache.get(key);
    if (c && c.exp > Date.now()) return c.hit;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'kronos-agent-osv-check' },
        body: JSON.stringify({ package: { name: pkg.name, ecosystem: pkg.ecosystem }, ...(pkg.version ? { version: pkg.version } : {}) }),
        signal: ctl.signal,
      });
      if (!res.ok) return null; // fail-open, not cached
      const data = (await res.json()) as { vulns?: { id: string; summary?: string }[] };
      const mal = (data.vulns ?? []).filter((v) => v.id.startsWith('MAL-'));
      const hit = mal.length ? { pkg, ids: mal.slice(0, 3).map((v) => v.id), summary: mal.slice(0, 2).map((v) => (v.summary ?? v.id).slice(0, 120)).join('; ') } : null;
      this.cache.set(key, { exp: Date.now() + this.ttlMs, hit });
      this.save();
      return hit;
    } catch (e) {
      log.debug(`OSV lookup for ${key} failed (allowing)`, e);
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  /** The first known-malware package a command would install or run, if any. */
  async checkCommand(command: string): Promise<MalwareHit | null> {
    const pkgs = packagesInCommand(command).slice(0, 10);
    const hits = await Promise.all(pkgs.map((p) => this.check(p)));
    return hits.find((h): h is MalwareHit => Boolean(h)) ?? null;
  }
}

export function describeHit(h: MalwareHit): string {
  return `${h.pkg.name}${h.pkg.version ? `@${h.pkg.version}` : ''} (${h.pkg.ecosystem}) has known malware advisories: ${h.ids.join(', ')} — ${h.summary}`;
}
