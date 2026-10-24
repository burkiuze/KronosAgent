import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function kronosHome(): string {
  const env = process.env.KRONOS_HOME;
  if (env) return resolve(expandHome(env));
  return join(homedir(), '.kronos');
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

export function resolvePath(p: string, cwd: string): string {
  const e = expandHome(p);
  return isAbsolute(e) ? resolve(e) : resolve(cwd, e);
}

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

export function profileDir(home: string, profile: string): string {
  if (!profile || profile === 'default') return home;
  if (!PROFILE_NAME_RE.test(profile)) throw new Error(`invalid profile name "${profile}"`);
  return join(home, 'profiles', profile);
}

export function activeProfile(home: string): string {
  if (process.env.KRONOS_PROFILE) return process.env.KRONOS_PROFILE;
  const f = join(home, 'active_profile');
  if (existsSync(f)) {
    const name = readFileSync(f, 'utf8').trim();
    if (name && PROFILE_NAME_RE.test(name)) return name;
  }
  return 'default';
}

export function setActiveProfile(home: string, profile: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'active_profile'), `${profile}\n`);
}

export function listProfiles(home: string): string[] {
  const out = ['default'];
  const dir = join(home, 'profiles');
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      try {
        if (statSync(join(dir, name)).isDirectory() && PROFILE_NAME_RE.test(name)) out.push(name);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

export interface ProfilePaths {
  root: string;
  config: string;
  soul: string;
  memories: string;
  skills: string;
  agents: string;
  commands: string;
  sessionsDb: string;
  sessionsDir: string;
  artifacts: string;
  cron: string;
  checkpoints: string;
  logs: string;
  cache: string;
  outputs: string;
}

export function profilePaths(root: string): ProfilePaths {
  return {
    root,
    config: join(root, 'config.yaml'),
    soul: join(root, 'SOUL.md'),
    memories: join(root, 'memories'),
    skills: join(root, 'skills'),
    agents: join(root, 'agents'),
    commands: join(root, 'commands'),
    sessionsDb: join(root, 'sessions.db'),
    sessionsDir: join(root, 'sessions'),
    artifacts: join(root, 'artifacts'),
    cron: join(root, 'cron'),
    checkpoints: join(root, 'checkpoints'),
    logs: join(root, 'logs'),
    cache: join(root, 'cache'),
    outputs: join(root, 'outputs'),
  };
}

export function ensureDirs(p: ProfilePaths): void {
  for (const d of [p.root, p.memories, p.skills, p.agents, p.commands, p.artifacts, p.cron, p.checkpoints, p.logs, p.cache, p.outputs]) {
    mkdirSync(d, { recursive: true });
  }
}

/** Locate the bundled skills directory shipped with Kronos (repo root /skills or packaged copy). */
export function bundledSkillsDir(): string | undefined {
  const candidates: string[] = [];
  if (process.env.KRONOS_BUNDLED_SKILLS) candidates.push(process.env.KRONOS_BUNDLED_SKILLS);
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    // dist/config -> packages/core -> repo root
    candidates.push(resolve(here, '../../../../skills'), resolve(here, '../../skills'), resolve(here, '../../../skills'));
  } catch {
    /* bundled (cjs) builds set KRONOS_BUNDLED_SKILLS instead */
  }
  return candidates.find((c) => existsSync(join(c)) && existsSync(c) && statSync(c).isDirectory());
}
