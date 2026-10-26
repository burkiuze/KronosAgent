import { runProcess } from '../util/process.js';

/** One line of a hunk with its numbers on the old and new side. */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** text after the second @@ (usually the enclosing function) */
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** What to review. */
export type DiffSpec =
  | { kind: 'workspace' }
  | { kind: 'staged' }
  | { kind: 'range'; base: string; head?: string }
  | { kind: 'commit'; commit: string }
  | { kind: 'raw'; diff: string }
  /** whole files, no diff (open-code-review's scan): every line is reviewed */
  | { kind: 'scan'; paths: string[] };

function unquote(p: string): string {
  const s = p.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function stripPrefix(p: string): string {
  const s = unquote(p);
  return s.startsWith('a/') || s.startsWith('b/') ? s.slice(2) : s;
}

/** Parse `git diff` / unified diff output, keeping the line numbers of both sides. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const start = (path: string): DiffFile => {
    file = { path, status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0 };
    files.push(file);
    hunk = undefined;
    oldLeft = newLeft = 0;
    return file;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/(.+?)"? "?b\/(.+?)"?|(\S+) (\S+))$/.exec(line);
      const f = start(stripPrefix(m?.[2] ?? m?.[4] ?? line.split(' ').pop() ?? ''));
      const oldP = m?.[1] ?? m?.[3];
      if (oldP && stripPrefix(oldP) !== f.path) f.oldPath = stripPrefix(oldP);
      continue;
    }
    if (hunk && file && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === '+') {
        hunk.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
        file.additions++;
        newLeft--;
        continue;
      }
      if (c === '-') {
        hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
        file.deletions++;
        oldLeft--;
        continue;
      }
      if (c === ' ' || line === '') {
        hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (h) {
      if (!file) start('unknown');
      hunk = { oldStart: Number(h[1]), oldLines: h[2] === undefined ? 1 : Number(h[2]), newStart: Number(h[3]), newLines: h[4] === undefined ? 1 : Number(h[4]), section: h[5] ?? '', lines: [] };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      file!.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4).replace(/\t.*$/, '');
      if (!file || file.hunks.length) start(stripPrefix(p));
      if (p === '/dev/null') file!.status = 'added';
      else if (!file!.oldPath && stripPrefix(p) !== file!.path) file!.oldPath = stripPrefix(p);
      continue;
    }
    if (line.startsWith('+++ ') && file) {
      const p = line.slice(4).replace(/\t.*$/, '');
      if (p === '/dev/null') file.status = 'deleted';
      else {
        if (file.path === 'unknown' || file.status === 'added' || !file.path) file.path = stripPrefix(p);
        else if (stripPrefix(p) !== file.path) {
          file.oldPath = file.path;
          file.path = stripPrefix(p);
        }
      }
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) file.oldPath = unquote(line.slice(12));
    else if (line.startsWith('rename to ')) {
      file.path = unquote(line.slice(10));
      file.status = 'renamed';
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
  }
  for (const f of files) {
    if (f.status === 'modified' && f.oldPath && f.oldPath !== f.path) f.status = 'renamed';
    if (f.oldPath === f.path) delete f.oldPath;
  }
  return files.filter((f) => f.path && f.path !== 'unknown');
}

/** Line numbers on the new side that were added. */
export function addedLines(f: DiffFile): Set<number> {
  const out = new Set<number>();
  for (const h of f.hunks) for (const l of h.lines) if (l.kind === 'add' && l.newNo) out.add(l.newNo);
  return out;
}

/** Every new-side line a review comment may be attached to (added or context lines of a hunk). */
export function commentableLines(f: DiffFile): Set<number> {
  const out = new Set<number>();
  for (const h of f.hunks) for (const l of h.lines) if (l.newNo) out.add(l.newNo);
  return out;
}

/** Render one file's hunks with new-side line numbers, the way reviewers read them. */
export function renderFileDiff(f: DiffFile, maxLines = 4000): string {
  const head =
    f.status === 'added' ? `new file ${f.path}` : f.status === 'deleted' ? `deleted ${f.path}` : f.status === 'renamed' ? `renamed ${f.oldPath} → ${f.path}` : `modified ${f.path}`;
  const out = [`### ${head} (+${f.additions} −${f.deletions})`];
  if (f.binary) return `${out[0]}\n(binary file)`;
  let n = 0;
  for (const h of f.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ` ${h.section}` : ''}`);
    for (const l of h.lines) {
      if (++n > maxLines) {
        out.push(`… (${f.additions + f.deletions} changed lines in total; read the file for the rest)`);
        return out.join('\n');
      }
      const num = l.newNo !== undefined ? String(l.newNo).padStart(5) : '     ';
      out.push(`${num} ${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`);
    }
  }
  return out.join('\n');
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const r = await runProcess('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeoutMs: 60_000, signal, maxBuffer: 64 * 1024 * 1024 });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.output).trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout;
}

/** The default branch to compare against: origin/HEAD, then main/master. */
export async function defaultBase(cwd: string): Promise<string | undefined> {
  try {
    const ref = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (ref) return ref;
  } catch {
    /* no origin/HEAD */
  }
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`]);
      return b;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export interface CollectedDiff {
  files: DiffFile[];
  /** human description: "uncommitted changes", "main...HEAD", "commit abc123" */
  label: string;
  raw: string;
  /** the commit the new side corresponds to, when there is one */
  headSha?: string;
}

/**
 * Collect the diff to review. `workspace` covers staged, unstaged and untracked files against
 * HEAD; `range` is `git diff base...head` (changes since the merge base, like a pull request).
 */
export async function collectDiff(cwd: string, spec: DiffSpec, signal?: AbortSignal): Promise<CollectedDiff> {
  const opts = ['--no-color', '--no-ext-diff', '-M', '--unified=3'];
  switch (spec.kind) {
    case 'raw':
      return { files: parseUnifiedDiff(spec.diff), label: 'patch', raw: spec.diff };
    case 'scan':
      return { files: await scanFiles(cwd, spec.paths, signal), label: `scan of ${spec.paths.length ? spec.paths.join(', ') : 'the repository'}`, raw: '' };
    case 'staged': {
      const raw = await git(cwd, ['diff', ...opts, '--cached'], signal);
      return { files: parseUnifiedDiff(raw), label: 'staged changes', raw };
    }
    case 'commit': {
      const raw = await git(cwd, ['show', ...opts, '--format=', spec.commit], signal);
      const sha = (await git(cwd, ['rev-parse', spec.commit], signal)).trim();
      return { files: parseUnifiedDiff(raw), label: `commit ${sha.slice(0, 10)}`, raw, headSha: sha };
    }
    case 'range': {
      const head = spec.head ?? 'HEAD';
      const raw = await git(cwd, ['diff', ...opts, `${spec.base}...${head}`], signal);
      const sha = (await git(cwd, ['rev-parse', head], signal).catch(() => '')).trim() || undefined;
      return { files: parseUnifiedDiff(raw), label: `${spec.base}...${head}`, raw, headSha: sha };
    }
    default: {
      let hasHead = true;
      try {
        await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal);
      } catch {
        hasHead = false;
      }
      let raw = hasHead ? await git(cwd, ['diff', ...opts, 'HEAD'], signal) : await git(cwd, ['diff', ...opts, '--cached'], signal);
      // untracked files are part of "my changes" too
      const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean);
      for (const p of untracked.slice(0, 500)) {
        const r = await runProcess('git', ['-c', 'core.quotepath=off', 'diff', ...opts, '--no-index', '--', '/dev/null', p], { cwd, timeoutMs: 30_000, signal, maxBuffer: 16 * 1024 * 1024 });
        if (r.stdout) raw += (raw && !raw.endsWith('\n') ? '\n' : '') + r.stdout;
      }
      return { files: parseUnifiedDiff(raw), label: 'uncommitted changes', raw };
    }
  }
}

/** Whole files as if newly added, so the review pipeline can scan them like a diff. */
async function scanFiles(cwd: string, paths: string[], signal?: AbortSignal): Promise<DiffFile[]> {
  const { walk } = await import('../util/glob.js');
  const { existsSync, readFileSync, statSync } = await import('node:fs');
  const { relative, resolve } = await import('node:path');
  const { looksBinary } = await import('../util/text.js');
  const rels = new Set<string>();
  for (const p of paths.length ? paths : ['.']) {
    const abs = resolve(cwd, p);
    if (!existsSync(abs)) throw new Error(`${p} does not exist`);
    if (statSync(abs).isFile()) rels.add(relative(cwd, abs));
    else for (const e of await walk(abs, { maxFiles: 5000, signal })) if (!e.isDir) rels.add(relative(cwd, e.path));
  }
  const out: DiffFile[] = [];
  for (const rel of [...rels].sort()) {
    const abs = resolve(cwd, rel);
    const buf = statSync(abs).size > 2 * 1024 * 1024 ? Buffer.from([0]) : readFileSync(abs);
    if (looksBinary(buf)) {
      out.push({ path: rel, status: 'added', binary: true, hunks: [], additions: 0, deletions: 0 });
      continue;
    }
    const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
    out.push({
      path: rel,
      status: 'added',
      binary: false,
      additions: lines.length,
      deletions: 0,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, section: '', lines: lines.map((text, i) => ({ kind: 'add' as const, text, newNo: i + 1 })) }],
    });
  }
  return out;
}
