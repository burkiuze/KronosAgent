import { readFileSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';
import type { ToolDefinition } from './types.js';
import { resolvePath } from '../config/paths.js';
import { walk } from '../util/glob.js';

/**
 * A map of the repository: the files that matter most, each with its definitions (classes,
 * functions, types, methods — as signature lines). One call shows where things live, so an agent
 * starts editing the right file instead of spending a dozen list/grep/read steps finding it.
 * Files are ranked by how many other files use their symbols (the code everything else depends
 * on comes first), boosted by `focus`, and the map is cut to a token budget.
 */

interface Def {
  line: number;
  depth: number;
  text: string;
  name: string;
}

interface FileInfo {
  mtimeMs: number;
  size: number;
  defs: Def[];
  idents: Set<string>;
}

type Lang = 'js' | 'py' | 'go' | 'rs' | 'java' | 'rb' | 'php' | 'c' | 'swift' | 'ex' | 'lua' | 'sh';

const LANGS: Record<string, Lang> = {
  '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.vue': 'js', '.svelte': 'js',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java', '.kt': 'java', '.kts': 'java', '.scala': 'java', '.cs': 'java', '.dart': 'java', '.groovy': 'java',
  '.rb': 'rb',
  '.php': 'php',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.cxx': 'c', '.hpp': 'c', '.hh': 'c', '.m': 'c', '.mm': 'c',
  '.swift': 'swift',
  '.ex': 'ex', '.exs': 'ex',
  '.lua': 'lua',
  '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh',
};

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'else', 'do', 'try', 'with', 'match', 'case', 'when', 'unless', 'sizeof', 'typeof']);

/** [pattern, group holding the name] per language; patterns run per line. */
const PATTERNS: Record<Lang, RegExp[]> = {
  js: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/,
    /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function/,
    /^export\s+const\s+([A-Za-z_$][\w$]*)/,
    // class members: two or four spaces of indentation
    /^ {2}(?: {2})?(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^=]*?)?\s*\{\s*$/,
  ],
  py: [/^\s*class\s+([A-Za-z_]\w*)/, /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/],
  rs: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|type|mod)\s+([A-Za-z_]\w*)/,
    /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/,
  ],
  java: [
    /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial)\s+)*(?:class|interface|enum|record|object|struct|trait)\s+([A-Za-z_]\w*)/,
    /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|suspend|async|virtual|open)\s+)+(?:fun\s+|def\s+)?(?:<[^>]+>\s+)?(?:[\w<>[\],.? ]+\s+)?([A-Za-z_]\w*)\s*\(/,
    /^\s*(?:fun|def)\s+(?:<[^>]+>\s+)?([A-Za-z_]\w*)\s*\(/,
  ],
  rb: [/^\s*(?:class|module)\s+([A-Z][\w:]*)/, /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/],
  php: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+([A-Za-z_]\w*)/],
  c: [/^(?:class|struct|union|enum|namespace)\s+([A-Za-z_]\w*)\s*[:{]?\s*$/, /^(?:[\w*&:<>,]+\s+)+\**([A-Za-z_][\w:]*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/],
  swift: [/^\s*(?:(?:public|private|internal|open|final|fileprivate)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/, /^\s*(?:(?:public|private|internal|open|static|final|override|fileprivate|mutating)\s+)*func\s+([A-Za-z_]\w*)/],
  ex: [/^\s*defmodule\s+([A-Z][\w.]*)/, /^\s*defp?\s+([a-z_]\w*[?!]?)/],
  lua: [/^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/],
  sh: [/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/],
};

const cache = new Map<string, FileInfo>();
const MAX_FILE = 400_000;

function analyze(path: string, lang: Lang, mtimeMs: number, size: number): FileInfo {
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit;
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    /* unreadable */
  }
  const defs: Def[] = [];
  const lines = text.split('\n');
  let inBlockComment = false;
  for (let i = 0; i < lines.length && defs.length < 400; i++) {
    const raw = lines[i] as string;
    const t = raw.trim();
    if (inBlockComment) {
      if (t.includes('*/')) inBlockComment = false;
      continue;
    }
    if (t.startsWith('/*')) {
      inBlockComment = !t.includes('*/');
      continue;
    }
    if (!t || t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('--')) {
      if (!(lang === 'c' && t.startsWith('#define'))) continue;
    }
    for (const re of PATTERNS[lang]) {
      const m = re.exec(raw);
      if (!m) continue;
      const name = m[1] as string;
      if (KEYWORDS.has(name) || name.length < 2) break;
      const indent = raw.length - raw.trimStart().length;
      const depth = lang === 'go' || lang === 'c' ? 0 : Math.min(3, Math.round(indent / (raw.startsWith('\t') ? 1 : lang === 'py' || lang === 'rs' || lang === 'java' ? 4 : 2)));
      // Python, Ruby, Java & co.: only top level and one level of members
      if (depth > 1 && lang !== 'js') break;
      let sig = t.replace(/\s*\{\s*$/, '').replace(/\s*:\s*$/, lang === 'py' ? '' : ':').replace(/\s+/g, ' ');
      if (sig.length > 140) sig = `${sig.slice(0, 139)}…`;
      defs.push({ line: i + 1, depth, text: sig, name });
      break;
    }
  }
  const idents = new Set<string>(text.length > MAX_FILE ? [] : (text.match(/[A-Za-z_][\w$]{2,}/g) ?? []));
  const info = { mtimeMs, size, defs, idents };
  cache.set(path, info);
  return info;
}

export interface RepoMapOptions {
  maxTokens?: number;
  /** files or identifiers to put first */
  focus?: string[];
  signal?: AbortSignal;
}

/** The repository map of `root` as text, within roughly `maxTokens` tokens. */
export async function buildRepoMap(root: string, opts: RepoMapOptions = {}): Promise<{ text: string; files: number; shown: number }> {
  const budget = Math.max(200, Math.min(20_000, opts.maxTokens ?? 2500)) * 4;
  const entries = await walk(root, { maxFiles: 30_000, signal: opts.signal });
  const files: { rel: string; info: FileInfo }[] = [];
  let bytes = 0;
  for (const e of entries) {
    const lang = LANGS[extname(e.rel).toLowerCase()];
    if (!lang || /\.(min|bundle)\.js$|\.d\.ts$/.test(e.rel)) continue;
    let st;
    try {
      st = statSync(e.path);
    } catch {
      continue;
    }
    if (st.size > MAX_FILE || (bytes += st.size) > 60_000_000) continue;
    files.push({ rel: e.rel, info: analyze(e.path, lang, st.mtimeMs, st.size) });
  }

  // rank: a file matters when other files use what it defines
  const usedIn = new Map<string, number>();
  for (const f of files) for (const id of f.info.idents) usedIn.set(id, (usedIn.get(id) ?? 0) + 1);
  const focus = (opts.focus ?? []).map((s) => s.trim()).filter(Boolean);
  const scored = files.map((f) => {
    let score = 0;
    const names = new Set(f.info.defs.map((d) => d.name));
    for (const n of names) score += Math.max(0, (usedIn.get(n) ?? 0) - 1);
    score = Math.log1p(score) + Math.min(f.info.defs.length, 20) * 0.05;
    const base = basename(f.rel).replace(/\.\w+$/, '').toLowerCase();
    if (['index', 'main', 'app', 'server', 'cli', 'lib', 'mod', '__init__', 'manage'].includes(base)) score += 0.5;
    if (/(^|\/)(tests?|spec|__tests__|fixtures?|examples?|docs?)\//i.test(f.rel) || /\.(test|spec)\.\w+$|_test\.\w+$/.test(f.rel)) score -= 1.5;
    for (const q of focus) {
      if (f.rel === q || f.rel.endsWith(`/${q}`) || f.rel.includes(q)) score += 10;
      else if (names.has(q)) score += 6;
      else if (f.info.idents.has(q)) score += 1.5;
    }
    return { ...f, score };
  });
  scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));

  const out: string[] = [];
  let used = 0;
  let shown = 0;
  const rest: string[] = [];
  for (const f of scored) {
    // top-level definitions, plus the members other files use most
    const top = f.info.defs.filter((d) => d.depth === 0).slice(0, 15);
    const members = f.info.defs
      .filter((d) => d.depth > 0)
      .map((d) => ({ d, uses: (usedIn.get(d.name) ?? 0) + (focus.includes(d.name) ? 100 : 0) }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 8)
      .map((x) => x.d);
    const defs = [...top, ...members].sort((a, b) => a.line - b.line);
    const block = [`${f.rel}${f.info.defs.length ? '' : ' (no definitions found)'}`, ...defs.map((d) => `${'  '.repeat(Math.min(d.depth, 2) + 1)}${d.line}: ${d.text}`)];
    if (f.info.defs.length > defs.length) block.push(`  … ${f.info.defs.length - defs.length} more (read_file or grep for them)`);
    const size = block.join('\n').length + 1;
    if (used + size <= budget && f.info.defs.length) {
      out.push(block.join('\n'));
      used += size;
      shown++;
    } else rest.push(f.rel);
  }
  let tail = '';
  if (rest.length) {
    const names: string[] = [];
    let len = 0;
    for (const r of rest) {
      if (used + len + r.length + 2 > budget + 600) break;
      names.push(r);
      len += r.length + 2;
    }
    tail = `\n\nOther files (${rest.length}): ${names.join(', ')}${names.length < rest.length ? `, … ${rest.length - names.length} more` : ''}`;
  }
  const header = `Repository map of ${files.length} source file(s) — most-used code first; "line: signature" per definition.`;
  return { text: `${header}\n\n${out.join('\n\n')}${tail}`, files: files.length, shown };
}

export const repoMapTool: ToolDefinition<{ path?: string; focus?: string[]; max_tokens?: number }> = {
  name: 'repo_map',
  toolset: 'files',
  risk: 'read',
  parallelSafe: true,
  description:
    'Map of the codebase: the most important source files with their classes, functions, types and methods (signature and line number), ' +
    'most-used code first. Use it first in an unfamiliar repository to see where things live, then read only the files you need. ' +
    'Pass focus (file paths or identifiers from the task) to put the relevant code first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to map (default: working directory).' },
      focus: { type: 'array', items: { type: 'string' }, description: 'File paths or identifiers to rank first, e.g. ["auth", "parseToken"].' },
      max_tokens: { type: 'integer', minimum: 200, maximum: 20000, description: 'Size budget (default 2500).' },
    },
  },
  summarize: (i) => `Map ${i.path ?? 'repository'}${i.focus?.length ? ` (focus: ${i.focus.join(', ')})` : ''}`,
  async execute(input, ctx) {
    const root = resolvePath(input.path ?? '.', ctx.cwd);
    const map = await buildRepoMap(root, { maxTokens: input.max_tokens, focus: input.focus, signal: ctx.signal });
    if (!map.files) return { content: `No source files found under ${input.path ?? 'the working directory'}.` };
    return { content: map.text, meta: { path: root } };
  },
};
