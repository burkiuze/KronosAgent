import { commentableLines, type DiffFile } from './diff.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = ['bug', 'security', 'concurrency', 'performance', 'reliability', 'compatibility', 'test', 'maintainability', 'documentation', 'style'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Finding {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  title: string;
  body: string;
  severity: Severity;
  category: Category;
  /** 0..1, the reviewer's own estimate */
  confidence: number;
  /** replacement for lines startLine..endLine, exact indentation */
  suggestion?: string;
  /** the code the comment is about, as the reviewer quoted it (used to position the comment) */
  existingCode?: string;
  /** project rule file supporting the finding */
  rule?: string;
  group: number;
  /** how the position was established */
  located: 'quote' | 'line' | 'moved' | 'file';
  /** the range touches the diff, so the comment can sit inline in a pull request */
  inDiff: boolean;
  verification?: { verdict: 'confirmed' | 'uncertain'; note?: string };
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function normalizeSeverity(v: unknown): Severity {
  const s = String(v ?? '').toLowerCase().trim();
  if ((SEVERITIES as readonly string[]).includes(s)) return s as Severity;
  // codex-style priorities and common synonyms
  if (/^p?0$|blocker|urgent/.test(s)) return 'critical';
  if (/^p?1$|major|error|severe/.test(s)) return 'high';
  if (/^p?2$|moderate|normal|warn/.test(s)) return 'medium';
  return 'low';
}

export function normalizeCategory(v: unknown): Category {
  const s = String(v ?? '').toLowerCase().trim();
  if ((CATEGORIES as readonly string[]).includes(s)) return s as Category;
  if (/secur|vuln|inject|xss|auth/.test(s)) return 'security';
  if (/race|thread|lock|concurr|async/.test(s)) return 'concurrency';
  if (/perf|slow|memory|leak/.test(s)) return 'performance';
  if (/compat|breaking|api/.test(s)) return 'compatibility';
  if (/test/.test(s)) return 'test';
  if (/doc|comment|typo/.test(s)) return 'documentation';
  if (/style|format|naming|lint/.test(s)) return 'style';
  if (/maint|refactor|readab|dup/.test(s)) return 'maintainability';
  if (/error|reliab|crash|handling/.test(s)) return 'reliability';
  return 'bug';
}

const norm = (l: string) => l.trim().replace(/\s+/g, ' ');

/** Where a quoted snippet occurs in `lines` (1-based start lines), ignoring indentation and blank lines. */
export function findSnippet(lines: string[], snippet: string): { start: number; end: number }[] {
  const want = snippet.split('\n').map(norm).filter(Boolean);
  if (!want.length) return [];
  const idx: number[] = [];
  const text: string[] = [];
  lines.forEach((l, i) => {
    const n = norm(l);
    if (n) {
      idx.push(i);
      text.push(n);
    }
  });
  const hits: { start: number; end: number }[] = [];
  for (let i = 0; i + want.length <= text.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      const a = text[i + j] as string;
      const b = want[j] as string;
      // the first and last quoted lines may be partial
      if (!(a === b || ((j === 0 || j === want.length - 1) && b.length >= 8 && a.includes(b)))) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push({ start: (idx[i] as number) + 1, end: (idx[i + want.length - 1] as number) + 1 });
  }
  return hits;
}

export interface FileView {
  diff: DiffFile;
  /** new-side content, when available */
  lines?: string[];
}

/** Resolve a path the model wrote ("src/a.ts", "./src/a.ts", "a.ts", "/abs/repo/src/a.ts") to a diff path. */
export function resolveFindingPath(path: string, files: Map<string, FileView>): string | undefined {
  const p = path.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  if (files.has(p)) return p;
  const suffix = [...files.keys()].filter((k) => p.endsWith(`/${k}`) || k.endsWith(`/${p}`));
  if (suffix.length === 1) return suffix[0];
  const base = p.split('/').pop();
  const same = [...files.keys()].filter((k) => k.split('/').pop() === base);
  return same.length === 1 ? same[0] : undefined;
}

/**
 * Pin a finding to the code it talks about. The quoted `existingCode` wins over the line numbers
 * the model gave (they drift): first inside the diff of that file, then anywhere in the file,
 * then — when the quote exists in exactly one other changed file — in that file. Without a quote
 * the given lines are kept and snapped onto the nearest diff line when they are just outside it.
 * Returns undefined when the finding cannot be tied to anything (dropped as unverifiable).
 */
export function locateFinding(f: Finding, files: Map<string, FileView>): Finding | undefined {
  const path = resolveFindingPath(f.path, files);
  const near = (hits: { start: number; end: number }[], prefer: Set<number>) =>
    hits
      .map((h) => ({ h, inDiff: rangeTouches(h.start, h.end, prefer), dist: Math.abs(h.start - f.startLine) }))
      .sort((a, b) => Number(b.inDiff) - Number(a.inDiff) || a.dist - b.dist)[0];
  if (f.existingCode?.trim()) {
    if (path) {
      const view = files.get(path)!;
      const lines = view.lines ?? newSideLines(view.diff);
      const best = near(findSnippet(lines, f.existingCode), commentableLines(view.diff));
      if (best) return { ...f, path, startLine: best.h.start, endLine: best.h.end, located: 'quote', inDiff: best.inDiff };
    }
    const elsewhere: { path: string; h: { start: number; end: number }; inDiff: boolean }[] = [];
    for (const [p, view] of files) {
      if (p === path) continue;
      const lines = view.lines ?? newSideLines(view.diff);
      const set = commentableLines(view.diff);
      for (const h of findSnippet(lines, f.existingCode)) elsewhere.push({ path: p, h, inDiff: rangeTouches(h.start, h.end, set) });
    }
    if (elsewhere.length === 1) {
      const e = elsewhere[0]!;
      return { ...f, path: e.path, startLine: e.h.start, endLine: e.h.end, located: 'moved', inDiff: e.inDiff };
    }
  }
  if (!path) return undefined;
  const view = files.get(path)!;
  const set = commentableLines(view.diff);
  const total = view.lines?.length ?? Math.max(0, ...set);
  let start = Math.max(1, Math.round(f.startLine || 0));
  let end = Math.max(start, Math.round(f.endLine || start));
  if (!f.startLine || start > total + 1) {
    // no usable line: attach to the file (summary only)
    const first = Math.min(...set);
    return { ...f, path, startLine: Number.isFinite(first) ? first : 1, endLine: Number.isFinite(first) ? first : 1, located: 'file', inDiff: false };
  }
  end = Math.min(end, Math.max(start, total));
  if (!rangeTouches(start, end, set)) {
    // a line or two outside the hunk: snap onto it
    const snapped = [...set].sort((a, b) => Math.abs(a - start) - Math.abs(b - start))[0];
    if (snapped !== undefined && Math.abs(snapped - start) <= 3) {
      const len = end - start;
      start = snapped;
      end = snapped + len;
    }
  }
  return { ...f, path, startLine: start, endLine: end, located: 'line', inDiff: rangeTouches(start, end, set) };
}

function rangeTouches(start: number, end: number, set: Set<number>): boolean {
  for (let n = start; n <= end; n++) if (set.has(n)) return true;
  return false;
}

/** New-side lines reconstructed from the hunks (when the file itself is not at hand). */
export function newSideLines(diff: DiffFile): string[] {
  const out: string[] = [];
  for (const h of diff.hunks) for (const l of h.lines) if (l.newNo) out[l.newNo - 1] = l.text;
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = '';
  return out;
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Merge duplicates (same place, same problem) keeping the most severe, most confident one. */
export function dedupeFindings(list: Finding[]): Finding[] {
  const sorted = [...list].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence);
  const kept: Finding[] = [];
  for (const f of sorted) {
    const dup = kept.find(
      (k) =>
        k.path === f.path &&
        f.startLine <= k.endLine + 2 &&
        k.startLine <= f.endLine + 2 &&
        (similarity(`${k.title} ${k.body}`, `${f.title} ${f.body}`) >= 0.35 || (k.category === f.category && k.startLine === f.startLine)),
    );
    if (!dup) kept.push(f);
    else if (!dup.suggestion && f.suggestion && dup.startLine === f.startLine && dup.endLine === f.endLine) dup.suggestion = f.suggestion;
  }
  return kept;
}

export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.path.localeCompare(b.path) || a.startLine - b.startLine);
}
