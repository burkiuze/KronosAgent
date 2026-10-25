import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { dirname, extname, relative, basename } from 'node:path';
import type { ToolDefinition, ToolContext } from './types.js';
import type { ToolOutput } from '../types.js';
import { resolvePath } from '../config/paths.js';
import { decodeText, looksBinary, numberLines, truncate } from '../util/text.js';
import { unifiedDiff, diffStats, parsePatch, applyHunks } from '../util/diff.js';
import { walk, matchGlob, globToRegExp } from '../util/glob.js';
import { runProcess, which } from '../util/process.js';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_READ_BYTES = 20 * 1024 * 1024;

function rel(ctx: ToolContext, p: string): string {
  const r = relative(ctx.cwd, p);
  return r && !r.startsWith('..') ? r : p;
}

function ok(content: string, meta?: ToolOutput['meta']): ToolOutput {
  return { content, meta };
}
function fail(content: string): ToolOutput {
  return { content, isError: true };
}

function recordFileArtifact(ctx: ToolContext, path: string): void {
  try {
    ctx.runtime.artifacts.add({ kind: IMAGE_TYPES[extname(path).toLowerCase()] ? 'image' : 'file', title: basename(path), location: path, sessionId: ctx.sessionId, sessionTitle: ctx.agent.title });
  } catch {
    /* non fatal */
  }
}

function writeWithDiff(ctx: ToolContext, path: string, next: string, before: string | null): ToolOutput['meta'] {
  ctx.checkpoint(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  recordFileArtifact(ctx, path);
  const diff = unifiedDiff(before ?? '', next, rel(ctx, path));
  return { path, diff, ...diffStats(diff) };
}

// ---------------------------------------------------------------------------

export const readFileTool: ToolDefinition<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  toolset: 'files',
  risk: 'read',
  parallelSafe: true,
  description:
    'Read a file from the filesystem. Returns numbered lines (`N│text`). Use offset/limit (1-based line numbers) for large files. ' +
    'Images (png/jpg/gif/webp) are returned visually. Prefer this over `cat` in the shell.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path or path relative to the working directory.' },
      offset: { type: 'integer', description: 'First line to read (1-based).', minimum: 1 },
      limit: { type: 'integer', description: 'Maximum number of lines (default 2000).', minimum: 1 },
    },
    required: ['path'],
  },
  summarize: (i) => `Read ${i.path}${i.offset ? `:${i.offset}` : ''}`,
  async execute(input, ctx) {
    const path = resolvePath(input.path, ctx.cwd);
    if (!existsSync(path)) {
      const dir = dirname(path);
      const near = existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().includes(basename(path).toLowerCase().slice(0, 4))).slice(0, 5) : [];
      return fail(`File not found: ${input.path}${near.length ? `\nSimilar files in ${rel(ctx, dir) || '.'}: ${near.join(', ')}` : ''}`);
    }
    const st = statSync(path);
    if (st.isDirectory()) return fail(`${input.path} is a directory. Use list_dir instead.`);
    if (st.size > MAX_READ_BYTES) return fail(`${input.path} is ${(st.size / 1e6).toFixed(1)} MB — too large. Use grep or the shell (head/tail) to inspect parts of it.`);
    const ext = extname(path).toLowerCase();
    const readKey = `${path}#${input.offset ?? 1}:${input.limit ?? 2000}`;
    if (!IMAGE_TYPES[ext]) {
      // the same range of an unchanged file is already in the conversation: say so instead of
      // paying for the whole file again
      const seen = ctx.agent.cachedRead(readKey, st.mtimeMs, st.size);
      if (seen) {
        ctx.agent.noteRead(path);
        return ok(`${input.path} has not changed since you read it earlier in this conversation (${seen.lines} lines) — its content is above. Use that; read again only after the file changes or with a different offset/limit.`, { path, unchanged: true });
      }
    }
    const buf = readFileSync(path);
    if (IMAGE_TYPES[ext]) {
      return { content: `Image ${input.path} (${(st.size / 1024).toFixed(0)} KB)`, images: [{ type: 'image', mediaType: IMAGE_TYPES[ext] as string, data: buf.toString('base64'), name: basename(path) }], meta: { path } };
    }
    if (ext === '.pdf') {
      if (await which('pdftotext')) {
        const r = await runProcess('pdftotext', ['-layout', path, '-'], { timeoutMs: 60_000 });
        if (r.exitCode === 0) return ok(truncate(r.stdout, 200_000), { path });
      }
      return fail('PDF text extraction needs `pdftotext` (poppler-utils). Try the `pdf` skill or install poppler.');
    }
    if (looksBinary(buf) && !/^\xff\xfe|^\xfe\xff/.test(buf.subarray(0, 2).toString('latin1'))) {
      return fail(`${input.path} looks like a binary file (${st.size} bytes). Use the shell (xxd, file, strings) to inspect it.`);
    }
    const { text, encoding } = decodeText(buf);
    const lines = text.split('\n');
    const offset = Math.max(1, input.offset ?? 1);
    const limit = input.limit ?? 2000;
    const slice = lines.slice(offset - 1, offset - 1 + limit).map((l) => (l.length > 2000 ? `${l.slice(0, 2000)}… [line truncated]` : l));
    let out = numberLines(slice.join('\n'), offset);
    const end = offset - 1 + slice.length;
    if (end < lines.length) out += `\n\n[showing lines ${offset}-${end} of ${lines.length}; use offset=${end + 1} to continue]`;
    if (encoding !== 'utf-8') out += `\n[transcoded from ${encoding}]`;
    if (!text) out = '(empty file)';
    ctx.agent.noteRead(path);
    return ok(out, { path, lines: lines.length, read: { key: readKey, mtimeMs: st.mtimeMs, size: st.size, lines: lines.length } });
  },
};

export const writeFileTool: ToolDefinition<{ path: string; content: string }> = {
  name: 'write_file',
  toolset: 'files',
  risk: 'write',
  description: 'Create or overwrite a file with the given content (parent directories are created). For small changes to existing files prefer edit_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to the working directory).' },
      content: { type: 'string', description: 'Full file content.' },
    },
    required: ['path', 'content'],
  },
  summarize: (i) => `Write ${i.path}`,
  async execute(input, ctx) {
    const path = resolvePath(input.path, ctx.cwd);
    if (existsSync(path) && statSync(path).isDirectory()) return fail(`${input.path} is a directory`);
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const meta = writeWithDiff(ctx, path, input.content, before);
    const lines = input.content.split('\n').length;
    return ok(`${before === null ? 'Created' : 'Overwrote'} ${rel(ctx, path)} (${lines} lines, ${Buffer.byteLength(input.content)} bytes)`, meta);
  },
};

function normalizeWs(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n');
}

/** Find `old` in `src`; tolerate trailing-whitespace and indentation drift when the exact text is absent. */
function locate(src: string, old: string): { start: number; end: number; count: number } | { error: string } {
  const count = old ? src.split(old).length - 1 : 0;
  if (count >= 1) {
    const start = src.indexOf(old);
    return { start, end: start + old.length, count };
  }
  // fuzzy: compare line-by-line ignoring trailing whitespace and leading indentation
  const srcLines = src.split('\n');
  const oldLines = normalizeWs(old).split('\n');
  const trimmed = oldLines.map((l) => l.trim());
  const matches: number[] = [];
  for (let i = 0; i <= srcLines.length - oldLines.length; i += 1) {
    let okm = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if ((srcLines[i + j] as string).trim() !== trimmed[j]) {
        okm = false;
        break;
      }
    }
    if (okm) matches.push(i);
  }
  if (matches.length === 1) {
    const i = matches[0] as number;
    const start = srcLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
    const end = start + srcLines.slice(i, i + oldLines.length).join('\n').length;
    return { start, end, count: 1 };
  }
  if (matches.length > 1) return { error: `old_string matches ${matches.length} places (ignoring whitespace); add surrounding lines to make it unique.` };
  // help the model recover: show the closest line
  const first = trimmed.find((l) => l.length > 3) ?? '';
  const idx = srcLines.findIndex((l) => first && l.includes(first.slice(0, Math.min(40, first.length))));
  const hint = idx >= 0 ? `\nClosest match near line ${idx + 1}:\n${numberLines(srcLines.slice(Math.max(0, idx - 2), idx + 5).join('\n'), Math.max(1, idx - 1))}` : '';
  return { error: `old_string was not found in the file. Re-read the file and copy the exact text (including indentation).${hint}` };
}

function applyEdit(src: string, old: string, next: string, replaceAll?: boolean): string | { error: string } {
  if (old === next) return { error: 'old_string and new_string are identical' };
  if (replaceAll) {
    if (!src.includes(old)) return { error: 'old_string was not found in the file' };
    return src.split(old).join(next);
  }
  const loc = locate(src, old);
  if ('error' in loc) return loc;
  if (loc.count > 1) return { error: `old_string occurs ${loc.count} times. Add more context to make it unique, or set replace_all: true.` };
  return src.slice(0, loc.start) + next + src.slice(loc.end);
}

export const editFileTool: ToolDefinition<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> = {
  name: 'edit_file',
  toolset: 'files',
  risk: 'write',
  description:
    'Replace an exact string in a file. old_string must match the file content uniquely (include enough surrounding lines). ' +
    'Set replace_all to change every occurrence. To create a file use write_file; old_string "" with a non-existent path also creates it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace (copy it from read_file output without the line-number prefix).' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  summarize: (i) => `Edit ${i.path}`,
  async execute(input, ctx) {
    const path = resolvePath(input.path, ctx.cwd);
    if (!existsSync(path)) {
      if (input.old_string === '') {
        const meta = writeWithDiff(ctx, path, input.new_string, null);
        return ok(`Created ${rel(ctx, path)}`, meta);
      }
      return fail(`File not found: ${input.path}`);
    }
    const src = readFileSync(path, 'utf8');
    const res = applyEdit(src, input.old_string, input.new_string, input.replace_all);
    if (typeof res !== 'string') return fail(res.error);
    const meta = writeWithDiff(ctx, path, res, src);
    return ok(`Edited ${rel(ctx, path)} (+${meta?.added ?? 0} −${meta?.removed ?? 0})`, meta);
  },
};

export const multiEditTool: ToolDefinition<{ path: string; edits: { old_string: string; new_string: string; replace_all?: boolean }[] }> = {
  name: 'multi_edit',
  toolset: 'files',
  risk: 'write',
  description: 'Apply several edits to one file atomically (in order). Each edit works like edit_file. Either all succeed or nothing is written.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      edits: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  summarize: (i) => `Edit ${i.path} (${i.edits?.length ?? 0} changes)`,
  async execute(input, ctx) {
    const path = resolvePath(input.path, ctx.cwd);
    if (!existsSync(path)) return fail(`File not found: ${input.path}`);
    const src = readFileSync(path, 'utf8');
    let cur = src;
    for (const [i, e] of input.edits.entries()) {
      const r = applyEdit(cur, e.old_string, e.new_string, e.replace_all);
      if (typeof r !== 'string') return fail(`Edit ${i + 1} failed: ${r.error}\nNo changes were written.`);
      cur = r;
    }
    const meta = writeWithDiff(ctx, path, cur, src);
    return ok(`Applied ${input.edits.length} edits to ${rel(ctx, path)} (+${meta?.added ?? 0} −${meta?.removed ?? 0})`, meta);
  },
};

export const applyPatchTool: ToolDefinition<{ patch: string }> = {
  name: 'apply_patch',
  toolset: 'files',
  risk: 'write',
  description:
    'Apply a patch touching one or more files. Accepts a standard unified diff (--- a/x +++ b/x @@ … @@) or the envelope format:\n' +
    '*** Begin Patch\n*** Update File: path\n@@ optional context line\n-old\n+new\n*** Add File: path\n+line\n*** Delete File: path\n*** End Patch',
  parameters: {
    type: 'object',
    properties: { patch: { type: 'string', description: 'Patch text.' } },
    required: ['patch'],
  },
  summarize: (i) => {
    const files = [...(i.patch ?? '').matchAll(/^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ b\/)(.+)$/gm)].map((m) => m[1]);
    return `Patch ${files.slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''}`;
  },
  async execute(input, ctx) {
    let patches;
    try {
      patches = parsePatch(input.patch);
    } catch (e) {
      return fail(`Could not parse patch: ${(e as Error).message}`);
    }
    if (!patches.length) return fail('No file changes found in the patch.');
    // dry run first so a failing hunk leaves the workspace untouched
    const planned: { path: string; next: string | null; before: string | null; moveTo?: string }[] = [];
    for (const p of patches) {
      const path = resolvePath(p.path, ctx.cwd);
      const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
      try {
        if (p.op === 'delete') planned.push({ path, next: null, before });
        else if (p.op === 'add') planned.push({ path, next: p.content ?? '', before });
        else {
          if (before === null) return fail(`Cannot update ${p.path}: file does not exist`);
          planned.push({ path, next: applyHunks(before, p), before, moveTo: p.moveTo ? resolvePath(p.moveTo, ctx.cwd) : undefined });
        }
      } catch (e) {
        return fail(`${(e as Error).message}\nNo files were changed.`);
      }
    }
    const diffs: string[] = [];
    const summary: string[] = [];
    for (const p of planned) {
      ctx.checkpoint(p.path);
      if (p.next === null) {
        rmSync(p.path, { force: true });
        summary.push(`deleted ${rel(ctx, p.path)}`);
        diffs.push(unifiedDiff(p.before ?? '', '', rel(ctx, p.path)));
        continue;
      }
      const target = p.moveTo ?? p.path;
      if (p.moveTo) ctx.checkpoint(p.moveTo);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, p.next);
      if (p.moveTo && p.moveTo !== p.path) rmSync(p.path, { force: true });
      recordFileArtifact(ctx, target);
      const d = unifiedDiff(p.before ?? '', p.next, rel(ctx, target));
      diffs.push(d);
      const s = diffStats(d);
      summary.push(`${p.before === null ? 'added' : 'updated'} ${rel(ctx, target)} (+${s.added} −${s.removed})`);
    }
    const diff = diffs.filter(Boolean).join('\n');
    return ok(`Patch applied:\n${summary.map((s) => `- ${s}`).join('\n')}`, { diff, paths: planned.map((p) => p.moveTo ?? p.path), ...diffStats(diff) });
  },
};

export const listDirTool: ToolDefinition<{ path?: string; depth?: number; all?: boolean }> = {
  name: 'list_dir',
  toolset: 'files',
  risk: 'read',
  parallelSafe: true,
  description: 'List a directory as a tree (dirs end with /, files show size). Skips node_modules, .git, build outputs and .gitignored files unless all=true.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory (default: working directory).' },
      depth: { type: 'integer', description: 'Recursion depth (default 2, max 6).', minimum: 1, maximum: 6 },
      all: { type: 'boolean', description: 'Include ignored files.' },
    },
  },
  summarize: (i) => `List ${i.path ?? '.'}`,
  async execute(input, ctx) {
    const root = resolvePath(input.path ?? '.', ctx.cwd);
    if (!existsSync(root)) return fail(`Directory not found: ${input.path}`);
    if (!statSync(root).isDirectory()) return fail(`${input.path} is a file. Use read_file.`);
    const depth = Math.min(6, input.depth ?? 2);
    const entries = await walk(root, { maxDepth: depth, includeDirs: true, maxFiles: 800, respectGitignore: !input.all, ignore: input.all ? [] : undefined, signal: ctx.signal });
    const lines = entries.map((e) => {
      const level = e.rel.split('/').length - 1;
      const name = e.rel.split('/').pop() as string;
      if (e.isDir) return `${'  '.repeat(level)}${name}/`;
      let size = '';
      try {
        const b = statSync(e.path).size;
        size = b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
      } catch {
        /* ignore */
      }
      return `${'  '.repeat(level)}${name}  (${size})`;
    });
    const header = `${rel(ctx, root) || '.'}/ — ${entries.filter((e) => !e.isDir).length} files, ${entries.filter((e) => e.isDir).length} dirs${entries.length >= 800 ? ' (truncated)' : ''}`;
    return ok(`${header}\n${lines.join('\n') || '(empty)'}`);
  },
};

export const globTool: ToolDefinition<{ pattern: string; path?: string }> = {
  name: 'glob',
  toolset: 'files',
  risk: 'read',
  parallelSafe: true,
  description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py", "*.{md,txt}"). Results sorted by modification time, newest first.',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory to search (default: working directory).' } },
    required: ['pattern'],
  },
  summarize: (i) => `Glob ${i.pattern}`,
  async execute(input, ctx) {
    const root = resolvePath(input.path ?? '.', ctx.cwd);
    const all = await walk(root, { maxFiles: 50_000, signal: ctx.signal });
    const re = globToRegExp(input.pattern.includes('/') || input.pattern.startsWith('**') ? input.pattern : `**/${input.pattern}`, { dot: true });
    const hits = all
      .filter((e) => re.test(e.rel))
      .map((e) => ({ rel: e.rel, mtime: statSync(e.path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!hits.length) return ok(`No files match ${input.pattern}`);
    const shown = hits.slice(0, 400).map((h) => h.rel);
    return ok(`${hits.length} file(s)${hits.length > 400 ? ' (showing 400)' : ''}:\n${shown.join('\n')}`);
  },
};

export const grepTool: ToolDefinition<{ pattern: string; path?: string; glob?: string; ignore_case?: boolean; context?: number; output_mode?: 'content' | 'files' | 'count'; max_results?: number; fixed_strings?: boolean }> = {
  name: 'grep',
  toolset: 'files',
  risk: 'read',
  parallelSafe: true,
  description: 'Search file contents with a regular expression (ripgrep when available). output_mode: content (default, with line numbers), files (paths only) or count.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex (or literal text with fixed_strings).' },
      path: { type: 'string', description: 'File or directory (default: working directory).' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
      ignore_case: { type: 'boolean' },
      fixed_strings: { type: 'boolean' },
      context: { type: 'integer', description: 'Lines of context around matches.', minimum: 0, maximum: 10 },
      output_mode: { type: 'string', enum: ['content', 'files', 'count'] },
      max_results: { type: 'integer', description: 'Cap on matches (default 200).' },
    },
    required: ['pattern'],
  },
  summarize: (i) => `Search "${truncate(i.pattern, 40)}"${i.glob ? ` in ${i.glob}` : ''}`,
  async execute(input, ctx) {
    const root = resolvePath(input.path ?? '.', ctx.cwd);
    const max = input.max_results ?? 200;
    const mode = input.output_mode ?? 'content';
    if (await which('rg')) {
      const args = ['--no-heading', '--color', 'never', '-n', '--max-columns', '400', '--max-columns-preview'];
      if (input.ignore_case) args.push('-i');
      if (input.fixed_strings) args.push('-F');
      if (input.context && mode === 'content') args.push('-C', String(input.context));
      if (input.glob) args.push('-g', input.glob);
      if (mode === 'files') args.push('-l');
      if (mode === 'count') args.push('-c');
      args.push('--', input.pattern, root);
      const r = await runProcess('rg', args, { timeoutMs: 60_000, signal: ctx.signal, cwd: ctx.cwd });
      if (r.exitCode === 1) return ok(`No matches for ${input.pattern}`);
      if (r.exitCode !== 0 && !r.stdout) return fail(r.stderr || 'grep failed');
      const lines = r.stdout.split('\n').filter(Boolean).map((l) => (l.startsWith(root) ? l.slice(root.length + 1) : l));
      const more = lines.length > max ? `\n… ${lines.length - max} more lines (narrow the search)` : '';
      return ok(lines.slice(0, max).join('\n') + more);
    }
    let re: RegExp;
    try {
      re = new RegExp(input.fixed_strings ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : input.pattern, input.ignore_case ? 'i' : '');
    } catch (e) {
      return fail(`Invalid regex: ${(e as Error).message}`);
    }
    const files = statSync(root).isFile() ? [{ path: root, rel: basename(root), isDir: false }] : await walk(root, { maxFiles: 30_000, signal: ctx.signal });
    const out: string[] = [];
    let total = 0;
    for (const f of files) {
      if (input.glob && !matchGlob(f.rel, input.glob)) continue;
      let buf: Buffer;
      try {
        if (statSync(f.path).size > 5_000_000) continue;
        buf = readFileSync(f.path);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      let count = 0;
      for (let i = 0; i < lines.length; i += 1) {
        if (!re.test(lines[i] as string)) continue;
        count += 1;
        total += 1;
        if (mode === 'content' && out.length < max) {
          const c = input.context ?? 0;
          for (let j = Math.max(0, i - c); j <= Math.min(lines.length - 1, i + c); j += 1) {
            out.push(`${f.rel}:${j + 1}${j === i ? ':' : '-'}${(lines[j] as string).slice(0, 400)}`);
          }
        }
      }
      if (count && mode === 'files') out.push(f.rel);
      if (count && mode === 'count') out.push(`${f.rel}:${count}`);
      if (out.length >= max) break;
    }
    if (!out.length) return ok(`No matches for ${input.pattern}`);
    return ok(out.slice(0, max).join('\n') + (total > max && mode === 'content' ? `\n… more matches (narrow the search)` : ''));
  },
};

export const fsTool: ToolDefinition<{ action: 'mkdir' | 'move' | 'copy' | 'delete' | 'stat'; path: string; to?: string }> = {
  name: 'fs',
  toolset: 'files',
  risk: (i) => (i.action === 'stat' ? 'read' : 'write'),
  description: 'Filesystem operations: mkdir, move (rename), copy, delete (files or directories; deletions are checkpointed when small), stat.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['mkdir', 'move', 'copy', 'delete', 'stat'] },
      path: { type: 'string' },
      to: { type: 'string', description: 'Destination for move/copy.' },
    },
    required: ['action', 'path'],
  },
  summarize: (i) => `${i.action} ${i.path}${i.to ? ` → ${i.to}` : ''}`,
  async execute(input, ctx) {
    const path = resolvePath(input.path, ctx.cwd);
    switch (input.action) {
      case 'mkdir':
        mkdirSync(path, { recursive: true });
        return ok(`Created directory ${rel(ctx, path)}`);
      case 'stat': {
        if (!existsSync(path)) return fail(`${input.path} does not exist`);
        const st = statSync(path);
        return ok(JSON.stringify({ path, type: st.isDirectory() ? 'directory' : 'file', size: st.size, modified: st.mtime.toISOString(), mode: (st.mode & 0o777).toString(8) }, null, 2));
      }
      case 'move':
      case 'copy': {
        if (!input.to) return fail('"to" is required');
        if (!existsSync(path)) return fail(`${input.path} does not exist`);
        const to = resolvePath(input.to, ctx.cwd);
        mkdirSync(dirname(to), { recursive: true });
        if (statSync(path).isFile()) {
          ctx.checkpoint(to);
          if (input.action === 'move') ctx.checkpoint(path);
        }
        if (input.action === 'move') renameSync(path, to);
        else cpSync(path, to, { recursive: true });
        return ok(`${input.action === 'move' ? 'Moved' : 'Copied'} ${rel(ctx, path)} → ${rel(ctx, to)}`);
      }
      case 'delete': {
        if (!existsSync(path)) return ok(`${input.path} already absent`);
        if (statSync(path).isFile()) ctx.checkpoint(path);
        rmSync(path, { recursive: true, force: true });
        return ok(`Deleted ${rel(ctx, path)}`);
      }
      default:
        return fail(`unknown action ${String(input.action)}`);
    }
  },
};

export const fileTools = [readFileTool, writeFileTool, editFileTool, multiEditTool, applyPatchTool, listDirTool, globTool, grepTool, fsTool] as ToolDefinition[];
