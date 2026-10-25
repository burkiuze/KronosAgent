import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { t } from './i18n';

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? '').split(/\s/)[0] ?? '';
      let html: string;
      try {
        html = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value;
      } catch {
        html = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
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

const cache = new Map<string, string>();

export function renderMarkdown(src: string): string {
  const hit = cache.get(src);
  if (hit) return hit;
  const raw = marked.parse(src, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'data-copy'] });
  if (src.length < 20000) {
    if (cache.size > 500) cache.clear();
    cache.set(src, clean);
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
