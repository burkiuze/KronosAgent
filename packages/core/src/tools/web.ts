import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition, ToolContext } from './types.js';
import type { KronosConfig } from '../config/schema.js';
import { decodeEntities, htmlToMarkdown } from '../util/html.js';
import { Bm25Index } from '../util/bm25.js';
import { truncate } from '../util/text.js';
import { runProcess, which } from '../util/process.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

type SearchProvider = 'duckduckgo' | 'brave' | 'tavily' | 'exa' | 'searxng' | 'serper' | 'jina';

export function pickSearchProvider(cfg: KronosConfig['web']['search']): SearchProvider {
  if (cfg.provider && cfg.provider !== 'auto') return cfg.provider;
  if (process.env.TAVILY_API_KEY) return 'tavily';
  if (process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (process.env.EXA_API_KEY) return 'exa';
  if (process.env.SERPER_API_KEY) return 'serper';
  if (process.env.JINA_API_KEY) return 'jina';
  if (process.env.SEARXNG_URL || cfg.url) return 'searxng';
  return 'duckduckgo';
}

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function webSearch(query: string, limit: number, cfg: KronosConfig['web'], signal?: AbortSignal): Promise<{ provider: SearchProvider; results: SearchResult[]; answer?: string }> {
  const provider = pickSearchProvider(cfg.search);
  const key = cfg.search.apiKey;
  switch (provider) {
    case 'tavily': {
      const j = (await getJson('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: key || process.env.TAVILY_API_KEY, query, max_results: limit, include_answer: true }),
        signal,
      })) as { answer?: string; results?: { title: string; url: string; content: string }[] };
      return { provider, answer: j.answer, results: (j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })) };
    }
    case 'brave': {
      const j = (await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
        headers: { accept: 'application/json', 'x-subscription-token': key || process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || '' },
        signal,
      })) as { web?: { results?: { title: string; url: string; description: string }[] } };
      return { provider, results: (j.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: htmlToMarkdown(r.description).markdown })) };
    }
    case 'exa': {
      const j = (await getJson('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key || process.env.EXA_API_KEY || '' },
        body: JSON.stringify({ query, numResults: limit, contents: { text: { maxCharacters: 600 } } }),
        signal,
      })) as { results?: { title: string; url: string; text?: string }[] };
      return { provider, results: (j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.text ?? '' })) };
    }
    case 'serper': {
      const j = (await getJson('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key || process.env.SERPER_API_KEY || '' },
        body: JSON.stringify({ q: query, num: limit }),
        signal,
      })) as { answerBox?: { answer?: string; snippet?: string }; organic?: { title: string; link: string; snippet: string }[] };
      return { provider, answer: j.answerBox?.answer ?? j.answerBox?.snippet, results: (j.organic ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet })) };
    }
    case 'jina': {
      const j = (await getJson(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${key || process.env.JINA_API_KEY}`, 'x-respond-with': 'no-content' },
        signal,
      })) as { data?: { title: string; url: string; description: string }[] };
      return { provider, results: (j.data ?? []).slice(0, limit).map((r) => ({ title: r.title, url: r.url, snippet: r.description })) };
    }
    case 'searxng': {
      const base = (cfg.search.url || process.env.SEARXNG_URL || '').replace(/\/$/, '');
      const j = (await getJson(`${base}/search?q=${encodeURIComponent(query)}&format=json`, { signal })) as { results?: { title: string; url: string; content: string }[] };
      return { provider, results: (j.results ?? []).slice(0, limit).map((r) => ({ title: r.title, url: r.url, snippet: r.content })) };
    }
    default:
      return { provider: 'duckduckgo', results: await duckduckgo(query, limit, cfg.fetch.userAgent, signal) };
  }
}

async function duckduckgo(query: string, limit: number, ua: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': ua.replace(/KronosAgent[^ ]*/, 'Mozilla/5.0') },
    body: `q=${encodeURIComponent(query)}&kl=wt-wt`,
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo responded ${res.status}. Configure a search API key (Brave, Tavily, Exa, Serper) for reliable search.`);
  const html = await res.text();
  const results: SearchResult[] = [];
  const blockRe = /<div[^>]+class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && results.length < limit) {
    const block = m[1] ?? '';
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    let url = decodeEntities(a[1] ?? '');
    const ud = /[?&]uddg=([^&]+)/.exec(url);
    if (ud) url = decodeURIComponent(ud[1] as string);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const snip = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    results.push({
      title: decodeEntities((a[2] ?? '').replace(/<[^>]+>/g, '')).trim(),
      url,
      snippet: decodeEntities((snip?.[1] ?? '').replace(/<[^>]+>/g, '')).trim(),
    });
  }
  return results;
}

export const webSearchTool: ToolDefinition<{ query: string; limit?: number }> = {
  name: 'web_search',
  toolset: 'web',
  risk: 'network',
  parallelSafe: true,
  description:
    'Search the web. Returns titles, URLs and snippets (plus a direct answer when the provider has one). Follow up with web_fetch to read pages. ' +
    'Include the current year in queries about recent events.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Number of results (default 8).' },
    },
    required: ['query'],
  },
  summarize: (i) => `Search the web for "${truncate(i.query, 60)}"`,
  async execute(input, ctx) {
    const { provider, results, answer } = await webSearch(input.query, input.limit ?? 8, ctx.runtime.config.web, ctx.signal);
    if (!results.length && !answer) return { content: `No results for "${input.query}" (${provider}).` };
    const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${truncate(r.snippet.replace(/\s+/g, ' '), 300)}`);
    return {
      content: `${answer ? `Answer: ${answer}\n\n` : ''}${lines.join('\n\n')}\n\n(source: ${provider})`,
      meta: { provider, urls: results.map((r) => r.url) },
    };
  },
};

function focusSections(markdown: string, focus: string, maxChars: number): string {
  const sections = markdown.split(/\n(?=#{1,6} )|\n{2,}/).filter((s) => s.trim());
  const idx = new Bm25Index(sections.map((s, i) => ({ id: String(i), text: s, data: i })));
  const top = idx.search(focus, 40).map((h) => h.data).sort((a, b) => a - b);
  let out = '';
  for (const i of top) {
    const s = sections[i] as string;
    if (out.length + s.length > maxChars) break;
    out += `${s}\n\n`;
  }
  return out || markdown.slice(0, maxChars);
}

function recordLink(ctx: ToolContext, url: string, title: string): void {
  try {
    ctx.runtime.artifacts.add({ kind: 'link', title: title || new URL(url).host, location: url, sessionId: ctx.sessionId, sessionTitle: ctx.agent.title });
  } catch {
    /* ignore */
  }
}

export const webFetchTool: ToolDefinition<{ url: string; focus?: string; start_index?: number; max_chars?: number; raw?: boolean }> = {
  name: 'web_fetch',
  toolset: 'web',
  risk: 'network',
  parallelSafe: true,
  description:
    'Fetch a URL and return it as clean markdown (HTML), pretty JSON, plain text or extracted PDF text. ' +
    'Use focus to pull the most relevant sections of long pages and start_index to page through long content.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL.' },
      focus: { type: 'string', description: 'What you are looking for; returns the most relevant sections first.' },
      start_index: { type: 'integer', minimum: 0, description: 'Character offset for paging.' },
      max_chars: { type: 'integer', minimum: 1000, maximum: 200000 },
      raw: { type: 'boolean', description: 'Return raw HTML instead of markdown.' },
    },
    required: ['url'],
  },
  summarize: (i) => `Fetch ${truncate(i.url, 70)}`,
  async execute(input, ctx) {
    let url = input.url.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const cfg = ctx.runtime.config.web.fetch;
    const maxChars = input.max_chars ?? cfg.maxChars;
    const res = await fetch(url, {
      headers: { 'user-agent': cfg.userAgent, accept: 'text/html,application/xhtml+xml,application/json,text/plain,application/pdf;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(45_000)]),
    });
    const ctype = res.headers.get('content-type') ?? '';
    if (!res.ok) return { content: `HTTP ${res.status} ${res.statusText} for ${url}\n${truncate(await res.text().catch(() => ''), 1500)}`, isError: true };
    let title = '';
    let body: string;
    if (ctype.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (!(await which('pdftotext'))) return { content: `Downloaded a PDF (${buf.length} bytes) but pdftotext is not installed to extract it.`, isError: true };
      const dir = mkdtempSync(join(tmpdir(), 'kronos-pdf-'));
      try {
        writeFileSync(join(dir, 'f.pdf'), buf);
        const r = await runProcess('pdftotext', ['-layout', join(dir, 'f.pdf'), '-'], { timeoutMs: 60_000 });
        body = r.stdout;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else if (ctype.startsWith('image/')) {
      const buf = Buffer.from(await res.arrayBuffer());
      recordLink(ctx, url, url.split('/').pop() ?? 'image');
      return { content: `Image from ${url} (${ctype}, ${buf.length} bytes)`, images: [{ type: 'image', mediaType: ctype.split(';')[0] as string, data: buf.toString('base64') }] };
    } else {
      const text = await res.text();
      if (ctype.includes('json')) {
        try {
          body = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          body = text;
        }
      } else if (ctype.includes('html') || /^\s*<(!doctype|html)/i.test(text)) {
        if (input.raw) body = text;
        else {
          const ex = htmlToMarkdown(text, res.url || url);
          title = ex.title;
          body = `${ex.title ? `# ${ex.title}\n\n` : ''}${ex.markdown}`;
        }
      } else body = text;
    }
    recordLink(ctx, res.url || url, title);
    if (input.focus && body.length > maxChars) body = focusSections(body, input.focus, maxChars);
    const start = input.start_index ?? 0;
    const slice = body.slice(start, start + maxChars);
    const more = start + maxChars < body.length ? `\n\n[content truncated — ${body.length - start - maxChars} more chars; call again with start_index=${start + maxChars}]` : '';
    return { content: `Source: ${res.url || url}\n\n${slice}${more}`, meta: { url: res.url || url, title, length: body.length } };
  },
};

export const httpRequestTool: ToolDefinition<{ method?: string; url: string; headers?: Record<string, string>; body?: string; json?: unknown }> = {
  name: 'http_request',
  toolset: 'http',
  risk: (i) => (!i.method || i.method.toUpperCase() === 'GET' || i.method.toUpperCase() === 'HEAD' ? 'network' : 'external'),
  parallelSafe: true,
  description: 'Make an HTTP request to an API (any method, custom headers, JSON or raw body). Returns status, headers and body. Use environment variables via ${VAR} in headers for secrets.',
  parameters: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
      url: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: { type: 'string', description: 'Raw request body.' },
      json: { description: 'JSON body (sets content-type).' },
    },
    required: ['url'],
  },
  summarize: (i) => `${(i.method ?? 'GET').toUpperCase()} ${truncate(i.url, 70)}`,
  async execute(input, ctx) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers ?? {})) headers[k] = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n: string) => process.env[n] ?? '');
    let body: string | undefined = input.body;
    if (input.json !== undefined) {
      body = JSON.stringify(input.json);
      headers['content-type'] ??= 'application/json';
    }
    const res = await fetch(input.url, { method: (input.method ?? 'GET').toUpperCase(), headers, body, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]) });
    const text = await res.text();
    let pretty = text;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* keep raw */
      }
    }
    const hdrs = [...res.headers.entries()].filter(([k]) => !/set-cookie/i.test(k)).slice(0, 20).map(([k, v]) => `${k}: ${v}`).join('\n');
    return { content: `HTTP ${res.status} ${res.statusText}\n${hdrs}\n\n${truncate(pretty, 60_000)}`, isError: res.status >= 400 };
  },
};

export const webTools = [webSearchTool, webFetchTool, httpRequestTool] as ToolDefinition[];
