import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ToolDefinition } from './types.js';
import { htmlToMarkdown } from '../util/html.js';
import { truncate } from '../util/text.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type PW = { chromium: { launch(opts: Record<string, unknown>): Promise<any> } };

let cachedPw: PW | null | undefined;

export function loadOptional<T = unknown>(name: string): T | null {
  const bases: string[] = [];
  try {
    bases.push(import.meta.url);
  } catch {
    /* cjs bundle */
  }
  bases.push(join(process.cwd(), 'index.js'));
  for (const base of bases) {
    try {
      return createRequire(base)(name) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}

function playwright(): PW | null {
  if (cachedPw === undefined) cachedPw = loadOptional<PW>('playwright') ?? loadOptional<PW>('playwright-core');
  return cachedPw;
}

export class BrowserManager {
  private browser: any;
  private pages = new Map<string, any>();

  async page(sessionId: string, opts: { headless: boolean; executablePath?: string; viewport: { width: number; height: number } }): Promise<any> {
    const existing = this.pages.get(sessionId);
    if (existing && !existing.isClosed()) return existing;
    const pw = playwright();
    if (!pw) throw new Error('Browser automation needs Playwright: run `npm i -g playwright && npx playwright install chromium`.');
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await pw.chromium.launch({ headless: opts.headless, executablePath: opts.executablePath || process.env.KRONOS_CHROMIUM || undefined });
    }
    const context = await this.browser.newContext({ viewport: opts.viewport, userAgent: undefined });
    const page = await context.newPage();
    this.pages.set(sessionId, page);
    return page;
  }

  async close(sessionId?: string): Promise<void> {
    if (sessionId) {
      const p = this.pages.get(sessionId);
      this.pages.delete(sessionId);
      await p?.context().close().catch(() => undefined);
      return;
    }
    for (const p of this.pages.values()) await p.context().close().catch(() => undefined);
    this.pages.clear();
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
  }
}

const SNAPSHOT_JS = `(() => {
  const els = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=true],summary,label'));
  let n = 0; const out = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
    n++; el.setAttribute('data-kronos-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'input') : tag);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const extra = tag === 'a' && el.href ? ' -> ' + el.href.slice(0, 120) : '';
    out.push('[' + n + '] ' + role + ' "' + label + '"' + extra);
    if (out.length >= 250) break;
  }
  return { title: document.title, url: location.href, elements: out };
})()`;

function target(input: { ref?: number | string; selector?: string; text?: string }): string {
  if (input.ref !== undefined) return `[data-kronos-ref="${input.ref}"]`;
  if (input.selector) return input.selector;
  if (input.text) return `text=${input.text}`;
  throw new Error('provide ref (from snapshot), selector or text');
}

export const browserTool: ToolDefinition<{
  action: 'navigate' | 'snapshot' | 'click' | 'type' | 'press' | 'scroll' | 'screenshot' | 'extract' | 'back' | 'forward' | 'wait' | 'evaluate' | 'close';
  url?: string;
  ref?: number;
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  submit?: boolean;
  direction?: 'up' | 'down';
  full_page?: boolean;
  ms?: number;
  script?: string;
}> = {
  name: 'browser',
  toolset: 'browser',
  risk: (i) => (i.action === 'evaluate' ? 'execute' : 'network'),
  description:
    'Drive a real Chromium browser (Playwright). Typical flow: navigate → snapshot (numbered interactive elements) → click/type by ref → screenshot/extract. ' +
    'Actions: navigate{url}, snapshot, click{ref|selector|text}, type{ref|selector, value, submit?}, press{key}, scroll{direction}, ' +
    'screenshot{full_page?}, extract{selector?} (page as markdown), back, forward, wait{ms|selector}, evaluate{script}, close.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'screenshot', 'extract', 'back', 'forward', 'wait', 'evaluate', 'close'] },
      url: { type: 'string' },
      ref: { type: 'integer', description: 'Element number from the latest snapshot.' },
      selector: { type: 'string', description: 'CSS/Playwright selector.' },
      text: { type: 'string', description: 'Visible text to click.' },
      value: { type: 'string', description: 'Text to type.' },
      key: { type: 'string', description: 'Key to press, e.g. Enter, Tab, Control+A.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
      direction: { type: 'string', enum: ['up', 'down'] },
      full_page: { type: 'boolean' },
      ms: { type: 'integer' },
      script: { type: 'string', description: 'JavaScript expression evaluated in the page.' },
    },
    required: ['action'],
  },
  available: () => (playwright() ? null : 'Playwright is not installed'),
  summarize: (i) => `Browser ${i.action}${i.url ? ` ${truncate(i.url, 60)}` : i.ref !== undefined ? ` #${i.ref}` : i.selector ? ` ${i.selector}` : ''}`,
  async execute(input, ctx) {
    const mgr = ctx.runtime.browser;
    if (input.action === 'close') {
      await mgr.close(ctx.sessionId);
      return { content: 'Browser closed.' };
    }
    const page = await mgr.page(ctx.sessionId, ctx.runtime.config.browser);
    const timeout = 30_000;
    switch (input.action) {
      case 'navigate': {
        if (!input.url) return { content: 'url is required', isError: true };
        const url = /^https?:|^file:|^about:/.test(input.url) ? input.url : `https://${input.url}`;
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
        ctx.runtime.artifacts.add({ kind: 'link', title: (await page.title()) || url, location: page.url(), sessionId: ctx.sessionId, sessionTitle: ctx.agent.title });
        const snap = await page.evaluate(SNAPSHOT_JS);
        return { content: `Loaded ${page.url()} (HTTP ${res?.status() ?? '?'}) — "${snap.title}"\n\nInteractive elements:\n${snap.elements.join('\n')}` };
      }
      case 'snapshot': {
        const snap = await page.evaluate(SNAPSHOT_JS);
        return { content: `${snap.title}\n${snap.url}\n\n${snap.elements.join('\n') || '(no interactive elements)'}` };
      }
      case 'click':
        await page.locator(target(input)).first().click({ timeout });
        await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
        return { content: `Clicked. Now at ${page.url()} — "${await page.title()}". Take a new snapshot before using refs again.` };
      case 'type': {
        const loc = page.locator(target(input)).first();
        await loc.fill(input.value ?? '', { timeout });
        if (input.submit) await loc.press('Enter');
        return { content: `Typed into ${target(input)}${input.submit ? ' and submitted' : ''}.` };
      }
      case 'press':
        await page.keyboard.press(input.key ?? 'Enter');
        return { content: `Pressed ${input.key ?? 'Enter'}.` };
      case 'scroll':
        await page.mouse.wheel(0, input.direction === 'up' ? -900 : 900);
        return { content: `Scrolled ${input.direction ?? 'down'}.` };
      case 'back':
        await page.goBack({ timeout });
        return { content: `Back to ${page.url()}` };
      case 'forward':
        await page.goForward({ timeout });
        return { content: `Forward to ${page.url()}` };
      case 'wait':
        if (input.selector) await page.waitForSelector(input.selector, { timeout });
        else await page.waitForTimeout(Math.min(30_000, input.ms ?? 1000));
        return { content: 'Done waiting.' };
      case 'screenshot': {
        const buf: Buffer = await page.screenshot({ fullPage: Boolean(input.full_page), type: 'png' });
        return { content: `Screenshot of ${page.url()}`, images: [{ type: 'image', mediaType: 'image/png', data: buf.toString('base64'), name: 'screenshot.png' }] };
      }
      case 'extract': {
        const html: string = input.selector ? await page.locator(input.selector).first().innerHTML({ timeout }) : await page.content();
        const md = htmlToMarkdown(html, page.url()).markdown;
        return { content: `${page.url()}\n\n${truncate(md, 60_000)}` };
      }
      case 'evaluate': {
        const result = await page.evaluate(input.script ?? 'document.title');
        return { content: truncate(typeof result === 'string' ? result : JSON.stringify(result, null, 2), 30_000) };
      }
      default:
        return { content: `unknown action ${String(input.action)}`, isError: true };
    }
  },
};

export const browserTools = [browserTool] as ToolDefinition[];
