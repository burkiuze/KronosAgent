import type { Message, Part } from '../types.js';

/** Rough token estimate (≈4 chars per token for English/code, a bit denser for CJK). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0x3000 && c <= 0x9fff) cjk += 1;
  }
  return Math.ceil((text.length - cjk) / 3.8 + cjk * 1.2);
}

export function estimatePartTokens(p: Part): number {
  switch (p.type) {
    case 'text':
      return estimateTokens(p.text);
    case 'thinking':
      return estimateTokens(p.text) + (p.signature ? 50 : 0);
    case 'image':
      return 1600;
    case 'file':
      return estimateTokens(p.text ?? '') + 20;
    case 'tool_call':
      return estimateTokens(JSON.stringify(p.input)) + 20;
    case 'tool_result':
      return estimateTokens(p.content) + (p.images?.length ?? 0) * 1600 + 10;
    case 'raw':
      return estimateTokens(JSON.stringify(p.block ?? '')) ;
    default:
      return 0;
  }
}

export function estimateMessagesTokens(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += 4;
    for (const p of m.parts) n += estimatePartTokens(p);
  }
  return n;
}

/**
 * Truncate long tool output keeping the head and the tail, which is where
 * the useful information (commands, errors, summaries) usually lives.
 */
export function truncateMiddle(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  const headText = text.slice(0, head);
  const tailText = text.slice(text.length - tail);
  const omittedLines = text.slice(head, text.length - tail).split('\n').length - 1;
  return {
    text: `${headText}\n\n… [${omitted.toLocaleString()} characters / ~${omittedLines} lines omitted] …\n\n${tailText}`,
    truncated: true,
  };
}

export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

export function firstLine(text: string, max = 120): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return truncate(line.trim(), max);
}

export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((l) => (l ? prefix + l : l))
    .join('\n');
}

/** Number lines like `cat -n` (used by read_file so the model can cite lines). */
export function numberLines(text: string, start = 1): string {
  const lines = text.split('\n');
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width, ' ')}│${l}`).join('\n');
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '');
}

export function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < len; i += 1) {
    const b = buf[i] as number;
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32 && b !== 27)) suspicious += 1;
  }
  return len > 0 && suspicious / len > 0.1;
}

/** Decode a buffer to text, transcoding UTF-16 (BOM or heuristic) instead of refusing it. */
export function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  // UTF-16LE without BOM: many zero bytes at odd positions
  if (buf.length > 16) {
    let oddZeros = 0;
    const n = Math.min(buf.length, 2000);
    for (let i = 1; i < n; i += 2) if (buf[i] === 0) oddZeros += 1;
    if (oddZeros / (n / 2) > 0.6) return { text: buf.toString('utf16le'), encoding: 'utf-16le' };
  }
  return { text: buf.toString('utf8'), encoding: 'utf-8' };
}

/** Redact things that look like secrets before they reach logs, transcripts or chat platforms. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // telegram bot token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => `${m.slice(0, 6)}…[redacted]`);
  return out;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Very small Levenshtein for "did you mean" suggestions. */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) (dp[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const row = dp[i] as number[];
      const prev = dp[i - 1] as number[];
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return (dp[a.length] as number[])[b.length] as number;
}

export function closest(word: string, candidates: string[], maxDistance = 3): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(word.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= maxDistance ? best : undefined;
}
