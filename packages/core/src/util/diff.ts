/**
 * Line diffing (unified diff output) and patch application.
 * Supports standard unified diffs and the "*** Begin Patch" envelope used by
 * Codex-style models, so any model's preferred patch dialect just works.
 */

type Op = { kind: ' ' | '-' | '+'; line: string };

function lcsOps(a: string[], b: string[]): Op[] {
  // trim common prefix/suffix to keep the DP table tiny for typical edits
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: Op[] = a.slice(0, start).map((line) => ({ kind: ' ', line }));

  if (midA.length * midB.length > 4_000_000) {
    // too large for LCS: treat the middle as a replace block
    for (const line of midA) ops.push({ kind: '-', line });
    for (const line of midB) ops.push({ kind: '+', line });
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      const row = dp[i] as Uint32Array;
      const below = dp[i + 1] as Uint32Array;
      for (let j = m - 1; j >= 0; j -= 1) {
        row[j] = midA[i] === midB[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ kind: ' ', line: midA[i] as string });
        i += 1;
        j += 1;
      } else if ((dp[i + 1] as Uint32Array)[j]! >= (dp[i] as Uint32Array)[j + 1]!) {
        ops.push({ kind: '-', line: midA[i] as string });
        i += 1;
      } else {
        ops.push({ kind: '+', line: midB[j] as string });
        j += 1;
      }
    }
    while (i < n) ops.push({ kind: '-', line: midA[i++] as string });
    while (j < m) ops.push({ kind: '+', line: midB[j++] as string });
  }
  for (const line of a.slice(endA)) ops.push({ kind: ' ', line });
  return ops;
}

export function unifiedDiff(oldText: string, newText: string, path = 'file', context = 3): string {
  if (oldText === newText) return '';
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const ops = lcsOps(a, b);
  const hunks: string[] = [];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  const positions: { op: Op; o: number; n: number }[] = [];
  for (const op of ops) {
    positions.push({ op, o: oldLine, n: newLine });
    if (op.kind !== '+') oldLine += 1;
    if (op.kind !== '-') newLine += 1;
  }
  while (i < positions.length) {
    while (i < positions.length && positions[i]!.op.kind === ' ') i += 1;
    if (i >= positions.length) break;
    const start = Math.max(0, i - context);
    let end = i;
    let lastChange = i;
    while (end < positions.length && end - lastChange <= context * 2) {
      if (positions[end]!.op.kind !== ' ') lastChange = end;
      end += 1;
    }
    end = Math.min(positions.length, lastChange + context + 1);
    const slice = positions.slice(start, end);
    const oStart = slice[0]!.o;
    const nStart = slice[0]!.n;
    const oCount = slice.filter((p) => p.op.kind !== '+').length;
    const nCount = slice.filter((p) => p.op.kind !== '-').length;
    hunks.push(`@@ -${oCount ? oStart : oStart - 1},${oCount} +${nCount ? nStart : nStart - 1},${nCount} @@`);
    for (const p of slice) hunks.push(`${p.op.kind}${p.op.line}`);
    i = end;
  }
  return `--- a/${path}\n+++ b/${path}\n${hunks.join('\n')}`;
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) added += 1;
    else if (l.startsWith('-') && !l.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// Patch parsing / application
// ---------------------------------------------------------------------------

export interface FilePatch {
  op: 'update' | 'add' | 'delete';
  path: string;
  moveTo?: string;
  hunks: { context?: string; lines: Op[] }[];
  /** for add: full content */
  content?: string;
}

/** Parse either a unified diff (possibly multi-file) or a "*** Begin Patch" envelope. */
export function parsePatch(text: string): FilePatch[] {
  if (/^\*\*\* Begin Patch/m.test(text)) return parseEnvelope(text);
  return parseUnified(text);
}

function parseEnvelope(text: string): FilePatch[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let hunk: { context?: string; lines: Op[] } | null = null;
  for (const raw of lines) {
    let m: RegExpExecArray | null;
    if (raw.startsWith('*** Begin Patch') || raw.startsWith('*** End Patch') || raw === '*** End of File') continue;
    if ((m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(raw))) {
      cur = { op: (m[1] as string).toLowerCase() as FilePatch['op'], path: (m[2] as string).trim(), hunks: [] };
      if (cur.op === 'add') cur.content = '';
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if ((m = /^\*\*\* Move to: (.+)$/.exec(raw))) {
      cur.moveTo = (m[1] as string).trim();
      continue;
    }
    if (cur.op === 'add') {
      cur.content += `${raw.startsWith('+') ? raw.slice(1) : raw}\n`;
      continue;
    }
    if (raw.startsWith('@@')) {
      hunk = { context: raw.replace(/^@@\s?/, '').trim() || undefined, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      hunk = { lines: [] };
      cur.hunks.push(hunk);
    }
    const k = raw[0];
    if (k === '+' || k === '-' || k === ' ') hunk.lines.push({ kind: k, line: raw.slice(1) });
    else if (raw === '') hunk.lines.push({ kind: ' ', line: '' });
  }
  for (const f of files) if (f.op === 'add' && f.content?.endsWith('\n')) f.content = f.content.slice(0, -1);
  return files;
}

function parseUnified(text: string): FilePatch[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let hunk: { context?: string; lines: Op[] } | null = null;
  const strip = (p: string) => p.replace(/^[ab]\//, '').replace(/\t.*$/, '').trim();
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string;
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('new file mode') || raw.startsWith('deleted file mode')) continue;
    if (raw.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        const from = strip(raw.slice(4));
        const to = strip(next.slice(4));
        const op: FilePatch['op'] = from === '/dev/null' ? 'add' : to === '/dev/null' ? 'delete' : 'update';
        cur = { op, path: op === 'add' ? to : from, hunks: [] };
        if (op === 'update' && to !== from) cur.moveTo = to;
        files.push(cur);
        hunk = null;
        i += 1;
        continue;
      }
    }
    if (!cur) continue;
    if (raw.startsWith('@@')) {
      hunk = { lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith('\\ No newline')) continue;
    const k = raw[0];
    if (k === '+' || k === '-' || k === ' ') hunk.lines.push({ kind: k, line: raw.slice(1) });
    else if (raw === '' && i < lines.length - 1) hunk.lines.push({ kind: ' ', line: '' });
  }
  for (const f of files) {
    if (f.op === 'add') {
      f.content = f.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== '-').map((l) => l.line)).join('\n');
    }
  }
  return files;
}

function findBlock(haystack: string[], needle: string[], from: number): number {
  if (needle.length === 0) return from;
  const eq = (a: string, b: string, loose: boolean) => (loose ? a.trim() === b.trim() : a === b);
  for (const loose of [false, true]) {
    for (let i = from; i <= haystack.length - needle.length; i += 1) {
      let ok = true;
      for (let j = 0; j < needle.length; j += 1) {
        if (!eq(haystack[i + j] as string, needle[j] as string, loose)) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    // retry from the start of the file if not found after `from`
    for (let i = 0; i < Math.min(from, haystack.length - needle.length + 1); i += 1) {
      let ok = true;
      for (let j = 0; j < needle.length; j += 1) {
        if (!eq(haystack[i + j] as string, needle[j] as string, loose)) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return -1;
}

/** Apply hunks to file content. Throws with a helpful message if a hunk does not apply. */
export function applyHunks(original: string, patch: FilePatch): string {
  const lines = original.split('\n');
  let cursor = 0;
  for (const [idx, h] of patch.hunks.entries()) {
    if (h.context) {
      const c = findBlock(lines, [h.context], cursor);
      if (c >= 0) cursor = c;
    }
    const before = h.lines.filter((l) => l.kind !== '+').map((l) => l.line);
    const after = h.lines.filter((l) => l.kind !== '-').map((l) => l.line);
    // drop trailing empty context lines that often come from copy/paste
    while (before.length && before[before.length - 1] === '' && after.length && after[after.length - 1] === '') {
      before.pop();
      after.pop();
    }
    const at = findBlock(lines, before, cursor);
    if (at < 0) {
      throw new Error(
        `Hunk ${idx + 1} for ${patch.path} did not apply. Expected to find:\n${before.slice(0, 8).join('\n')}${before.length > 8 ? '\n…' : ''}`,
      );
    }
    lines.splice(at, before.length, ...after);
    cursor = at + after.length;
  }
  return lines.join('\n');
}
