/**
 * Finding the text an edit replaces, the way a careful person would when the model's copy of it
 * is slightly off. A chain of strategies, strict first (after Hermes' fuzzy_match): exact,
 * per-line trimmed, whitespace-collapsed, typographic-Unicode-normalized, literal "\n" escapes,
 * then anchors on the first and last line with a similar middle. JSON escape drift in the
 * model's arguments (\" for ", doubled backslashes) is corrected first, but only when the
 * corrected text is verifiably in the file.
 */

export interface EditMatch {
  start: number;
  end: number;
  /** strategy that found it ("exact", "line_trimmed", …) */
  strategy: string;
  /** replacement after escape-drift correction and re-indentation */
  replacement: string;
  /** what was adjusted, for the tool result */
  note?: string;
}

export type EditLocate = { matches: EditMatch[] } | { error: string };

const UNICODE: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '–': '-', '—': '-', '−': '-', '…': '...', ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '﻿': '',
  ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
};

export function unicodeNormalize(s: string): string {
  return s.replace(/[‘’‚‛′“”„‟″–—−…   ​﻿   　]/g, (c) => UNICODE[c] ?? c);
}

/** Dice coefficient over character bigrams: 1 = identical. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

/** Line-window matcher: spans of every window of the pattern's height whose lines agree under `same`. */
function lineWindows(src: string, pattern: string, same: (a: string, b: string) => boolean): { start: number; end: number }[] {
  const lines = src.split('\n');
  const pat = pattern.replace(/\n$/, '').split('\n');
  if (!pat.length || pat.length > lines.length) return [];
  const offsets: number[] = [];
  let pos = 0;
  for (const l of lines) {
    offsets.push(pos);
    pos += l.length + 1;
  }
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!same(lines[i + j] as string, pat[j] as string)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const last = i + pat.length - 1;
      out.push({ start: offsets[i] as number, end: (offsets[last] as number) + (lines[last] as string).length });
    }
  }
  return out;
}

const collapse = (l: string) => l.trim().replace(/[ \t]+/g, ' ');

function exactAll(src: string, pat: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (!pat) return out;
  let i = src.indexOf(pat);
  while (i >= 0) {
    out.push({ start: i, end: i + pat.length });
    i = src.indexOf(pat, i + pat.length);
  }
  return out;
}

/** Leading whitespace of the first non-blank line. */
function indentOf(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/**
 * When the model dropped (or added) a uniform indentation on the old text, apply the same shift
 * to the replacement, so the new code lands at the file's indentation.
 */
function reindent(replacement: string, patternText: string, matched: string): { text: string; shifted: boolean } {
  const want = indentOf(matched);
  const have = indentOf(patternText);
  if (want === have || !replacement.trim()) return { text: replacement, shifted: false };
  if (want.startsWith(have)) {
    const extra = want.slice(have.length);
    // only for a uniform shift: every line of the matched block carries the extra indentation
    if (!matched.split('\n').every((l) => !l.trim() || l.startsWith(extra))) return { text: replacement, shifted: false };
    return { text: replacement.split('\n').map((l) => (l.trim() ? extra + l : l)).join('\n'), shifted: true };
  }
  if (have.startsWith(want)) {
    const extra = have.slice(want.length);
    if (!replacement.split('\n').every((l) => !l.trim() || l.startsWith(extra))) return { text: replacement, shifted: false };
    return { text: replacement.split('\n').map((l) => (l.trim() ? l.slice(extra.length) : l)).join('\n'), shifted: true };
  }
  return { text: replacement, shifted: false };
}

/** Undo JSON double-escaping of the arguments when the corrected old text is in the file. */
export function correctEscapeDrift(src: string, old: string, next: string): { old: string; next: string; note?: string } | { error: string } {
  if (src.includes(old)) return { old, next };
  // \" or \' in both strings: quotes that picked up a backslash in transit
  for (const q of ['"', "'"]) {
    const esc = `\\${q}`;
    if (old.includes(esc) && !old.includes(`\\\\${q}`)) {
      const fixed = old.split(esc).join(q);
      if (src.includes(fixed)) {
        if (next.includes(`\\\\${q}`)) return { error: `Escaping looks garbled: old_string matches the file once \\${q} is read as ${q}, but new_string has deliberate escapes too. Re-read the file and resend both strings with their intended escaping.` };
        return { old: fixed, next: next.split(esc).join(q), note: `read \\${q} as ${q} (escape drift in the arguments)` };
      }
    }
  }
  // every backslash run doubled
  if (old.includes('\\\\') && (old.match(/\\+/g) ?? []).every((r) => r.length % 2 === 0)) {
    const halved = old.replace(/\\+/g, (r) => '\\'.repeat(r.length / 2));
    if (src.includes(halved)) {
      if (next.includes('\\')) return { error: 'Escaping looks garbled: old_string matches the file with its backslashes halved, but new_string has backslashes whose intent is unclear. Re-read the file and resend both strings with their intended escaping.' };
      return { old: halved, next, note: 'halved doubled backslashes in old_string (escape drift in the arguments)' };
    }
  }
  return { old, next };
}

/**
 * Locate `old` in `src` with the first strategy that finds anything. Similarity-based strategies
 * only accept a single candidate.
 */
export function locateEdit(src: string, oldText: string, newText: string): EditLocate {
  const drift = correctEscapeDrift(src, oldText, newText);
  if ('error' in drift) return drift;
  const old = drift.old;
  const notes = drift.note ? [drift.note] : [];
  const finish = (spans: { start: number; end: number }[], strategy: string, pattern = old): EditLocate => ({
    matches: spans.map((sp) => {
      const exactish = strategy === 'exact';
      const r = exactish ? { text: drift.next, shifted: false } : reindent(drift.next, pattern, src.slice(sp.start, sp.end));
      const n = [...notes];
      if (!exactish) n.push(`matched ${strategy.replace(/_/g, ' ')}`);
      if (r.shifted) n.push('re-indented the replacement to match the file');
      return { ...sp, strategy, replacement: r.text, note: n.length ? n.join('; ') : undefined };
    }),
  });

  const exact = exactAll(src, old);
  if (exact.length) return finish(exact, 'exact');
  if (!old.trim()) return { matches: [] };
  const strategies: [string, () => { start: number; end: number }[]][] = [
    ['ignoring_trailing_whitespace', () => lineWindows(src, old, (a, b) => a.trimEnd() === b.trimEnd())],
    ['ignoring_indentation', () => lineWindows(src, old, (a, b) => a.trim() === b.trim())],
    ['ignoring_whitespace', () => lineWindows(src, old, (a, b) => collapse(a) === collapse(b))],
    ['after_unicode_normalization', () => lineWindows(src, unicodeNormalize(old), (a, b) => collapse(unicodeNormalize(a)) === collapse(b))],
    [
      'after_unescaping',
      () => {
        if (!/\\[nt]/.test(old) || old.includes('\n')) return [];
        const un = old.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        return exactAll(src, un).length ? exactAll(src, un) : lineWindows(src, un, (a, b) => a.trim() === b.trim());
      },
    ],
  ];
  for (const [name, run] of strategies) {
    const spans = run();
    if (spans.length) return finish(spans, name);
  }
  // anchors: first and last lines agree, the middle is similar (unique candidate only)
  const pat = unicodeNormalize(old).replace(/\n$/, '').split('\n');
  if (pat.length >= 3) {
    const first = collapse(pat[0] as string);
    const last = collapse(pat[pat.length - 1] as string);
    const lines = src.split('\n').map((l) => collapse(unicodeNormalize(l)));
    const cands = lineWindows(src, old, () => true).filter((_, i) => lines[i] === first && lines[i + pat.length - 1] === last);
    const middle = pat.slice(1, -1).map(collapse).join('\n');
    const good = cands.filter((sp) => {
      const block = src.slice(sp.start, sp.end).split('\n').slice(1, -1).map((l) => collapse(unicodeNormalize(l))).join('\n');
      return similarity(block, middle) >= 0.8;
    });
    if (good.length === 1) {
      const m = finish(good, 'by_first_and_last_line') as { matches: EditMatch[] };
      m.matches[0]!.note = `${m.matches[0]!.note}; the middle lines only resemble old_string — check the diff`;
      return m;
    }
  }
  return { matches: [] };
}

/** The edit is already in the file: new text present, old text gone (a re-sent edit). */
export function alreadyApplied(src: string, oldText: string, newText: string): boolean {
  return newText.trim().length >= 8 && src.includes(newText) && !src.includes(oldText);
}
