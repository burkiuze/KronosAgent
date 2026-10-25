import { c, termWidth } from './ansi.js';

const KEYWORDS = new Set(
  'const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of def lambda pass raise with as yield None True False null undefined true false fn pub struct enum impl match use mod self Self interface type package func go defer select chan map range'.split(
    ' ',
  ),
);

/** Tiny token-level highlighter for code blocks (strings, comments, numbers, keywords). */
export function highlight(line: string): string {
  if (!c.enabled) return line;
  return line.replace(
    /(\/\/.*$|#(?!!).*$|--\s.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][\w]*)\b/g,
    (m, comment: string, str: string, num: string, word: string) => {
      if (comment) return c.gray(comment);
      if (str) return c.green(str);
      if (num) return c.amber(num);
      if (word && KEYWORDS.has(word)) return c.magenta(word);
      return m;
    },
  );
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_, code: string) => c.amber(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => c.bold(t))
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, (_, pre: string, t: string) => `${pre}${c.italic(t)}`)
    .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,!?:;]|$)/g, (_, pre: string, t: string) => `${pre}${c.italic(t)}`)
    .replace(/~~([^~]+)~~/g, (_, t: string) => c.dim(t))
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t: string, u: string) => `${c.underline(c.cyan(t))} ${c.gray(`(${u})`)}`);
}

/**
 * Streaming markdown → ANSI renderer. Feed it deltas; it emits whole rendered lines
 * as soon as they complete, keeping state for fenced code blocks and tables.
 */
export class MarkdownStream {
  private buf = '';
  private inCode = false;
  private codeLang = '';
  constructor(private out: (s: string) => void) {}

  push(delta: string): void {
    this.buf += delta;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.out(`${this.renderLine(line)}\n`);
    }
  }

  flush(): void {
    if (this.buf) {
      this.out(`${this.renderLine(this.buf)}\n`);
      this.buf = '';
    }
    this.inCode = false;
  }

  private renderLine(line: string): string {
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      if (!this.inCode) {
        this.inCode = true;
        this.codeLang = fence[1] ?? '';
        return c.gray(`  ╭─${this.codeLang ? ` ${this.codeLang} ` : ''}${'─'.repeat(Math.max(0, Math.min(40, termWidth() - 10 - this.codeLang.length)))}`);
      }
      this.inCode = false;
      return c.gray(`  ╰${'─'.repeat(Math.min(44, termWidth() - 6))}`);
    }
    if (this.inCode) {
      if (this.codeLang === 'diff') {
        if (line.startsWith('+')) return `${c.gray('  │ ')}${c.green(line)}`;
        if (line.startsWith('-')) return `${c.gray('  │ ')}${c.red(line)}`;
      }
      return `${c.gray('  │ ')}${highlight(line)}`;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const level = (m[1] as string).length;
      const text = inline(m[2] as string);
      return level <= 2 ? `\n${c.bold(c.gold(text))}` : c.bold(text);
    }
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) return c.gray('─'.repeat(Math.min(60, termWidth() - 4)));
    if ((m = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line))) return `${m[1]}${m[2] === ' ' ? c.gray('☐') : c.green('☑')} ${inline(m[3] as string)}`;
    if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) return `${m[1]}${c.gold('•')} ${inline(m[2] as string)}`;
    if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line))) return `${m[1]}${c.gold(`${m[2]}.`)} ${inline(m[3] as string)}`;
    if ((m = /^>\s?(.*)$/.exec(line))) return `${c.gray('▎')} ${c.italic(inline(m[1] as string))}`;
    if (/^\|.*\|\s*$/.test(line)) {
      if (/^\|[\s:-]+(\|[\s:-]+)*\|\s*$/.test(line)) return c.gray(line.replace(/[^|]/g, '─').replace(/\|/g, '┼'));
      return line
        .split('|')
        .map((cell, i, arr) => (i === 0 || i === arr.length - 1 ? '' : ` ${inline(cell.trim())} `))
        .join(c.gray('│'))
        .replace(/^/, c.gray('│'))
        .concat(c.gray('│'));
    }
    return inline(line);
  }
}

export function renderMarkdown(text: string): string {
  let out = '';
  const s = new MarkdownStream((x) => (out += x));
  s.push(text);
  s.flush();
  return out.replace(/\n$/, '');
}

export function renderDiff(diff: string, maxLines = 40): string {
  const lines = diff.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
  const shown = lines.slice(0, maxLines).map((l) => {
    if (l.startsWith('@@')) return c.cyan(l);
    if (l.startsWith('+')) return c.green(l);
    if (l.startsWith('-')) return c.red(l);
    return c.gray(l);
  });
  if (lines.length > maxLines) shown.push(c.gray(`… ${lines.length - maxLines} more lines`));
  return shown.map((l) => `     ${l}`).join('\n');
}
