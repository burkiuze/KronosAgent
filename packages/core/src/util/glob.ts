import { readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Convert a glob (supports **, *, ?, {a,b}, [abc]) to a RegExp anchored on the full path. */
export function globToRegExp(glob: string, opts: { dot?: boolean; nocase?: boolean } = {}): RegExp {
  let re = '';
  let i = 0;
  let inGroup = 0;
  const g = glob.replace(/\\/g, '/');
  while (i < g.length) {
    const c = g[i] as string;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const prevSlash = i === 0 || g[i - 1] === '/';
        const nextSlash = g[i + 2] === '/' || i + 2 === g.length;
        if (prevSlash && nextSlash) {
          re += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
          i += g[i + 2] === '/' ? 3 : 2;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += opts.dot ? '[^/]*' : '(?!\\.)[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') re += '[^/]';
    else if (c === '{') {
      inGroup += 1;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup -= 1;
      re += ')';
    } else if (c === ',' && inGroup) re += '|';
    else if (c === '[') {
      const end = g.indexOf(']', i);
      if (end > i) {
        re += `[${g.slice(i + 1, end).replace(/^!/, '^')}]`;
        i = end + 1;
        continue;
      }
      re += '\\[';
    } else if ('.+^$()|\\/'.includes(c)) re += `\\${c}`;
    else re += c;
    i += 1;
  }
  return new RegExp(`^${re}$`, opts.nocase ? 'i' : '');
}

export function matchGlob(path: string, glob: string): boolean {
  const p = path.replace(/\\/g, '/');
  if (!glob.includes('/')) return globToRegExp(glob, { dot: true }).test(p.split('/').pop() ?? p);
  return globToRegExp(glob, { dot: true }).test(p);
}

export const DEFAULT_IGNORES = [
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.nuxt', 'out', 'target', '__pycache__',
  '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.cache', 'coverage', '.turbo', '.parcel-cache',
  '.gradle', '.idea', '.DS_Store', 'vendor', '.terraform', '.kronos-test-home',
];

/** Lightweight .gitignore support (root file, simple patterns). */
export function loadGitignore(root: string): ((rel: string, isDir: boolean) => boolean) {
  const file = join(root, '.gitignore');
  if (!existsSync(file)) return () => false;
  const rules = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const negate = l.startsWith('!');
      let pat = negate ? l.slice(1) : l;
      const dirOnly = pat.endsWith('/');
      if (dirOnly) pat = pat.slice(0, -1);
      const anchored = pat.startsWith('/') || pat.includes('/');
      pat = pat.replace(/^\//, '');
      const re = globToRegExp(anchored ? pat : `**/${pat}`, { dot: true });
      return { negate, dirOnly, re };
    });
  return (rel, isDir) => {
    let ignored = false;
    const p = rel.replace(/\\/g, '/');
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(p)) ignored = !r.negate;
    }
    return ignored;
  };
}

export interface WalkOptions {
  maxFiles?: number;
  maxDepth?: number;
  includeDirs?: boolean;
  respectGitignore?: boolean;
  ignore?: string[];
  signal?: AbortSignal;
}

export interface WalkEntry {
  path: string;
  rel: string;
  isDir: boolean;
}

/** Iterative directory walk honoring default ignores and .gitignore. */
export async function walk(root: string, opts: WalkOptions = {}): Promise<WalkEntry[]> {
  const maxFiles = opts.maxFiles ?? 20000;
  const maxDepth = opts.maxDepth ?? 64;
  const ignoreNames = new Set([...(opts.ignore ?? []), ...DEFAULT_IGNORES]);
  const gi = opts.respectGitignore === false ? () => false : loadGitignore(root);
  const out: WalkEntry[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length && out.length < maxFiles) {
    if (opts.signal?.aborted) break;
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (ignoreNames.has(e.name)) continue;
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join('/');
      const isDir = e.isDirectory() || (e.isSymbolicLink() && (await stat(full).then((s) => s.isDirectory()).catch(() => false)));
      if (gi(rel, isDir)) continue;
      if (isDir) {
        if (opts.includeDirs) out.push({ path: full, rel, isDir: true });
        if (depth + 1 < maxDepth) queue.push({ dir: full, depth: depth + 1 });
      } else {
        out.push({ path: full, rel, isDir: false });
      }
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}
