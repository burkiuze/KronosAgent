import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { t } from './i18n';

// configured once: passing options to every sanitize() call re-parses and clones the whole
// configuration each time, which was most of the cost of rendering streaming Markdown
DOMPurify.setConfig({ ADD_ATTR: ['target', 'data-copy'] });

const escapeHtml = (text: string) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

/** True while rendering text that is still streaming in. */
let live = false;

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? '').split(/\s/)[0] ?? '';
      let html: string;
      try {
        // a block that is still streaming stays plain: re-highlighting a growing block on every
        // update is quadratic, and auto-detection tries every grammar. It is highlighted once complete.
        html = live ? escapeHtml(text) : language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value;
      } catch {
        html = escapeHtml(text);
      }
      const label = language || 'text';
      return `<div class="code-block"><div class="code-head"><span>${label}</span><button class="code-copy" data-copy>${t('common.copy')}</button></div><pre><code class="hljs language-${label}">${html}</code></pre></div>`;
    },
    link({ href, title, text }) {
      const t = title ? ` title="${title}"` : '';
      return `<a href="${href}"${t} target="_blank" rel="noreferrer noopener">${text}</a>`;
    },
  },
});

// Rendered HTML keyed by source, least-recently-used first, capped by total size so long
// sessions do not accumulate megabytes of stale renders.
const cache = new Map<string, string>();
const CACHE_BUDGET = 2_000_000; // characters of source + html
let cacheSize = 0;

/**
 * Markdown → sanitized HTML. `opts.live` marks text that is still streaming: it is neither cached
 * (every frame is a new prefix) nor run through code-language auto-detection.
 */
export function renderMarkdown(src: string, opts: { live?: boolean } = {}): string {
  const hit = cache.get(src);
  if (hit !== undefined) {
    cache.delete(src);
    cache.set(src, hit);
    return hit;
  }
  live = Boolean(opts.live);
  let clean: string;
  try {
    clean = DOMPurify.sanitize(marked.parse(src, { async: false }) as string);
  } finally {
    live = false;
  }
  if (!opts.live && src.length < 100_000) {
    cache.set(src, clean);
    cacheSize += src.length + clean.length;
    for (const [k, v] of cache) {
      if (cacheSize <= CACHE_BUDGET) break;
      cache.delete(k);
      cacheSize -= k.length + v.length;
    }
  }
  return clean;
}

/** Event delegation for "Copy" buttons inside rendered markdown. */
export function installCopyHandler(): void {
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null;
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    void navigator.clipboard?.writeText(code).then(() => {
      btn.textContent = '✓';
      setTimeout(() => (btn.textContent = t('common.copy')), 1200);
    });
  });
}

export function highlightCode(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  } catch {
    return code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
  }
}

export function langFromPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', rb: 'ruby',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash',
    bash: 'bash', zsh: 'bash', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', xml: 'xml',
    css: 'css', scss: 'scss', sql: 'sql', lua: 'lua', r: 'r', dart: 'dart', dockerfile: 'dockerfile',
  };
  return map[ext];
}
