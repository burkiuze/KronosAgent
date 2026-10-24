/**
 * Dependency-free HTML → Markdown converter tuned for feeding web pages to LLMs:
 * drops chrome (scripts, styles, nav, footers), keeps headings, links, lists,
 * code blocks and tables, and prefers <main>/<article> content when present.
 */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  bull: '•', middot: '·', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°',
  para: '¶', sect: '§', larr: '←', rarr: '→', uarr: '↑', darr: '↓', zwj: '', zwnj: '', shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

const DROP_BLOCKS = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'canvas', 'head', 'form', 'select', 'button', 'object'];
const CHROME_BLOCKS = ['nav', 'footer', 'aside'];
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'figure', 'figcaption', 'details', 'summary', 'address',
  'dl', 'dt', 'dd', 'fieldset', 'center', 'body', 'html',
]);

export interface HtmlExtract {
  title: string;
  markdown: string;
  description?: string;
  links: { text: string; href: string }[];
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return undefined;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

function resolveUrl(href: string, base?: string): string {
  if (!base) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function pickMainContent(html: string): string {
  for (const tag of ['main', 'article']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    let best = '';
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) if ((m[1]?.length ?? 0) > best.length) best = m[1] ?? '';
    if (best.length > 500) return best;
  }
  const role = /<div\b[^>]*role=["']main["'][^>]*>([\s\S]*)<\/div>/i.exec(html);
  if (role && (role[1]?.length ?? 0) > 500) return role[1] ?? html;
  return html;
}

export function htmlToMarkdown(html: string, baseUrl?: string, opts: { keepChrome?: boolean } = {}): HtmlExtract {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const description = attr(/<meta[^>]+name=["']description["'][^>]*>/i.exec(html)?.[0] ?? '', 'content');

  let src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  for (const t of DROP_BLOCKS) src = src.replace(new RegExp(`<${t}\\b[\\s\\S]*?</${t}>`, 'gi'), ' ');
  src = src.replace(/<(meta|link|input|base)\b[^>]*>/gi, '');
  if (!opts.keepChrome) {
    src = pickMainContent(src);
    for (const t of CHROME_BLOCKS) src = src.replace(new RegExp(`<${t}\\b[\\s\\S]*?</${t}>`, 'gi'), ' ');
  }

  const links: { text: string; href: string }[] = [];
  const out: string[] = [];
  const listStack: { ordered: boolean; n: number }[] = [];
  let inPre = 0;
  let linkHref: string | null = null;
  let linkText = '';
  let tableRow: string[] | null = null;
  let cell: string | null = null;
  let tableRows = 0;

  const emit = (s: string) => {
    if (cell !== null) cell += s;
    else if (linkHref !== null) linkText += s;
    else out.push(s);
  };
  const newline = (n = 1) => {
    if (cell !== null) {
      cell += ' ';
      return;
    }
    out.push('\n'.repeat(n));
  };

  const tokenRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\/?>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(src))) {
    const [token, rawName, text] = m;
    if (text !== undefined || token === '<') {
      let t = decodeEntities(text ?? '<');
      if (!inPre) t = t.replace(/\s+/g, ' ');
      emit(t);
      continue;
    }
    const name = (rawName ?? '').toLowerCase();
    const closing = token.startsWith('</');
    switch (name) {
      case 'br':
        if (inPre) emit('\n');
        else newline();
        break;
      case 'hr':
        newline(2);
        emit('---');
        newline(2);
        break;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        newline(2);
        if (!closing) emit(`${'#'.repeat(Number(name[1]))} `);
        break;
      case 'li':
        if (!closing) {
          newline();
          const depth = Math.max(0, listStack.length - 1);
          const top = listStack[listStack.length - 1];
          const bullet = top?.ordered ? `${++top.n}.` : '-';
          emit(`${'  '.repeat(depth)}${bullet} `);
        }
        break;
      case 'ul': case 'ol':
        if (closing) listStack.pop();
        else listStack.push({ ordered: name === 'ol', n: 0 });
        newline();
        break;
      case 'pre':
        if (closing) {
          inPre = Math.max(0, inPre - 1);
          emit('\n```');
          newline(2);
        } else {
          inPre += 1;
          const ahead = src.slice(tokenRe.lastIndex, tokenRe.lastIndex + 300);
          const lang =
            /class=["'][^"']*(?:language|lang)-([a-z0-9+#-]+)/i.exec(token)?.[1] ??
            /^\s*<code\b[^>]*class=["'][^"']*(?:language|lang)-([a-z0-9+#-]+)/i.exec(ahead)?.[1] ??
            '';
          newline(2);
          emit(`\`\`\`${lang}\n`);
        }
        break;
      case 'code':
        if (!inPre) emit('`');
        break;
      case 'strong': case 'b':
        emit('**');
        break;
      case 'em': case 'i':
        emit('_');
        break;
      case 'blockquote':
        newline(2);
        if (!closing) emit('> ');
        break;
      case 'a':
        if (closing) {
          if (linkHref !== null) {
            const txt = linkText.trim();
            const href = linkHref;
            linkHref = null;
            linkText = '';
            if (txt && href && !href.startsWith('javascript:')) {
              links.push({ text: txt, href });
              emit(`[${txt}](${href})`);
            } else emit(txt);
          }
        } else {
          const href = attr(token, 'href');
          if (href && !href.startsWith('#')) {
            linkHref = resolveUrl(href, baseUrl);
            linkText = '';
          }
        }
        break;
      case 'img': {
        const alt = attr(token, 'alt');
        const s = attr(token, 'src');
        if (alt && s && !s.startsWith('data:')) emit(`![${alt}](${resolveUrl(s, baseUrl)})`);
        break;
      }
      case 'table':
        newline(2);
        tableRows = 0;
        break;
      case 'tr':
        if (closing) {
          if (tableRow) {
            out.push(`| ${tableRow.join(' | ')} |\n`);
            if (tableRows === 0) out.push(`|${tableRow.map(() => ' --- ').join('|')}|\n`);
            tableRows += 1;
          }
          tableRow = null;
        } else tableRow = [];
        break;
      case 'td': case 'th':
        if (closing) {
          if (tableRow && cell !== null) tableRow.push(cell.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim());
          cell = null;
        } else cell = '';
        break;
      default:
        if (BLOCK_TAGS.has(name)) newline(closing ? 2 : 1);
    }
  }

  const markdown = out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+(?=[^\s-*\d|>`])/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\*\*\s*\*\*/g, '')
    .trim();
  return { title, markdown, description, links };
}

export function htmlToText(html: string): string {
  return htmlToMarkdown(html, undefined, { keepChrome: true })
    .markdown.replace(/[#*_`>]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}
