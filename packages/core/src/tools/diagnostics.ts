import { createRequire } from 'node:module';
import { extname, basename, join } from 'node:path';
import YAML from 'yaml';
import { runProcess, which } from '../util/process.js';

/**
 * Syntax check right after an edit. A broken bracket or indentation usually surfaces only much
 * later (a failing build, a confusing test error); reporting it in the edit's own result lets the
 * agent fix it while the change is still in front of it. Parse errors only — no type checking — so
 * it stays fast (milliseconds, or one short process for Python and plain-JS fallbacks).
 */

export interface SyntaxProblem {
  line: number;
  column: number;
  message: string;
}

const JS_LIKE = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_BYTES = 2_000_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TS = any;
const tsByRoot = new Map<string, TS | null>();

/** The workspace's own TypeScript when it has one, otherwise the one Kronos was built with. */
function typescriptFor(cwd: string): TS | null {
  if (tsByRoot.has(cwd)) return tsByRoot.get(cwd);
  let ts: TS | null = null;
  for (const from of [join(cwd, 'package.json'), import.meta.url]) {
    try {
      ts = createRequire(from)('typescript');
      break;
    } catch {
      /* try the next */
    }
  }
  tsByRoot.set(cwd, ts);
  return ts;
}

function jsProblems(ts: TS, path: string, text: string): SyntaxProblem[] {
  const ext = extname(path).toLowerCase();
  const kind = ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.jsx' ? ts.ScriptKind.JSX : ext.includes('ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const file = ts.createSourceFile(basename(path), text, ts.ScriptTarget.Latest, true, kind);
  const diags: { start?: number; messageText: unknown }[] = file.parseDiagnostics ?? [];
  return diags.map((d) => {
    const pos = file.getLineAndCharacterOfPosition(d.start ?? 0);
    return { line: pos.line + 1, column: pos.character + 1, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') };
  });
}

async function nodeCheck(path: string, cwd: string): Promise<SyntaxProblem[]> {
  const r = await runProcess(process.execPath, ['--check', path], { cwd, timeoutMs: 10_000 });
  if (r.exitCode === 0) return [];
  const m = /:(\d+)\s*\n[\s\S]*?\n(\w*Error: .+)/.exec(r.output);
  return [{ line: Number(m?.[1] ?? 1), column: 1, message: m?.[2] ?? r.output.trim().split('\n').pop() ?? 'syntax error' }];
}

async function pythonCheck(path: string, cwd: string): Promise<SyntaxProblem[]> {
  const py = (await which('python3')) ?? (await which('python'));
  if (!py) return [];
  const script = 'import ast,sys\ntry:\n ast.parse(open(sys.argv[1],encoding="utf-8").read(),sys.argv[1])\nexcept SyntaxError as e:\n print(f"{e.lineno or 1}\\t{e.offset or 1}\\t{e.msg}")';
  const r = await runProcess(py, ['-c', script, path], { cwd, timeoutMs: 10_000 });
  const line = r.stdout.trim();
  if (!line) return [];
  const [l, c, ...msg] = line.split('\t');
  return [{ line: Number(l) || 1, column: Number(c) || 1, message: msg.join('\t') || 'invalid syntax' }];
}

function jsonProblems(path: string, text: string): SyntaxProblem[] {
  // tsconfig, VS Code settings and friends are JSON with comments: skip what JSON.parse would misreport
  if (/\.jsonc$/i.test(path) || /(^|[/\\])(tsconfig|jsconfig)[^/\\]*\.json$/i.test(path) || /^\s*\/[/*]/m.test(text)) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (e) {
    const msg = (e as Error).message;
    const pos = Number(/position (\d+)/.exec(msg)?.[1] ?? NaN);
    const before = Number.isFinite(pos) ? text.slice(0, pos) : '';
    const line = Number(/line (\d+)/.exec(msg)?.[1] ?? (before ? before.split('\n').length : 1));
    const column = Number(/column (\d+)/.exec(msg)?.[1] ?? (before ? before.length - before.lastIndexOf('\n') : 1));
    return [{ line, column, message: msg.replace(/^JSON\.parse: /, '') }];
  }
}

function yamlProblems(text: string): SyntaxProblem[] {
  const out: SyntaxProblem[] = [];
  for (const doc of YAML.parseAllDocuments(text)) {
    for (const err of 'errors' in doc ? doc.errors : []) {
      const lp = err.linePos?.[0];
      out.push({ line: lp?.line ?? 1, column: lp?.col ?? 1, message: err.message.split('\n')[0] ?? err.code });
    }
  }
  return out;
}

/** Parse problems in `text` (the file's new content at `path`), or [] when it parses or the type is not checked. */
export async function syntaxProblems(path: string, text: string, cwd: string): Promise<SyntaxProblem[]> {
  if (Buffer.byteLength(text) > MAX_BYTES) return [];
  const ext = extname(path).toLowerCase();
  try {
    if (JS_LIKE.has(ext)) {
      const ts = typescriptFor(cwd);
      if (ts) return jsProblems(ts, path, text);
      return ['.js', '.mjs', '.cjs'].includes(ext) ? await nodeCheck(path, cwd) : [];
    }
    if (ext === '.json') return jsonProblems(path, text);
    if (ext === '.yaml' || ext === '.yml') return yamlProblems(text);
    if (ext === '.py') return await pythonCheck(path, cwd);
  } catch {
    /* a checker that breaks must never break the edit */
  }
  return [];
}

/** A note for the tool result, quoting the offending lines. */
export function formatSyntaxProblems(relPath: string, text: string, problems: SyntaxProblem[]): string {
  const lines = text.split('\n');
  const shown = problems.slice(0, 5).map((p) => {
    const src = (lines[p.line - 1] ?? '').replace(/\t/g, '  ');
    return `  ${relPath}:${p.line}:${p.column} ${p.message}${src.trim() ? `\n    | ${src.length > 160 ? `${src.slice(0, 160)}…` : src}` : ''}`;
  });
  const more = problems.length > 5 ? `\n  … ${problems.length - 5} more` : '';
  return `\n\n⚠ Syntax check failed — the file does not parse after this edit:\n${shown.join('\n')}${more}\nFix this before moving on.`;
}
