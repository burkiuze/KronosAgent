#!/usr/bin/env node
// End-to-end smoke test of the web UI: first boots a fresh install (no provider connected) to
// check the connect-first flow, then a gateway on a throwaway home with the offline demo model;
// drives the UI with Playwright (chromium) and fails on any page error.
// Usage: npm run build && npm run build:web && npm run test:e2e   (SCREENSHOTS=dir to keep shots)
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { Kronos } from '@kronos/core';
import { Gateway } from '@kronos/gateway';

// CommonJS resolution so a globally installed playwright (NODE_PATH) works too
const { chromium } = createRequire(import.meta.url)('playwright');

for (const k of Object.keys(process.env)) if (/_API_KEY$|^ANTHROPIC_AUTH_TOKEN$/.test(k)) delete process.env[k];
const home = mkdtempSync(join(tmpdir(), 'kronos-e2e-home-'));
const ws = mkdtempSync(join(tmpdir(), 'kronos-e2e-ws-'));
writeFileSync(join(ws, 'README.md'), '# e2e workspace\n\nHello from the Kronos e2e test.\n');
writeFileSync(join(ws, 'app.ts'), 'export const answer = 42;\n');
const shots = process.env.SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const freshHome = mkdtempSync(join(tmpdir(), 'kronos-e2e-fresh-'));
const rt = await Kronos.create({
  home,
  cwd: ws,
  connectMcp: false,
  logLevel: 'silent',
  overrides: { model: { default: 'kronos:demo' }, safety: { mode: 'yolo' }, skills: { claudeCompat: false } },
});
// a fake OpenAI-compatible API so the provider "connect" flow can be exercised offline
const fakeApi = createServer((req, res) => {
  const ok = req.headers.authorization === 'Bearer sk-good';
  if (ok && req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi from the connected model' } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(ok ? JSON.stringify({ data: [{ id: 'gpt-fake-large' }, { id: 'gpt-fake-mini' }] }) : '{"error":{"message":"invalid api key"}}');
});
await new Promise((r) => fakeApi.listen(0, '127.0.0.1', r));
const fakeOpenAi = { providers: { openai: { baseUrl: `http://127.0.0.1:${fakeApi.address().port}/v1` } } };
rt.updateConfig(fakeOpenAi);
// a fresh install: model "auto" and no keys anywhere — nothing to answer with until a provider is connected
const freshRt = await Kronos.create({ home: freshHome, cwd: ws, connectMcp: false, logLevel: 'silent', overrides: { skills: { claudeCompat: false } } });
freshRt.updateConfig(fakeOpenAi);

const gw = await Gateway.start(rt, { port: 0, host: '127.0.0.1', platforms: false, cron: false, token: 'e2e-token', quiet: true });
const freshGw = await Gateway.start(freshRt, { port: 0, host: '127.0.0.1', platforms: false, cron: false, token: 'e2e-token', quiet: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_ABORTED/.test(m.text()) && errors.push(`console: ${m.text()}`));

let step = 0;
async function check(name, fn) {
  step++;
  const started = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.message.split('\n')[0]}`);
    if (shots) await page.screenshot({ path: join(shots, `fail-${step}.png`) }).catch(() => undefined);
    throw e;
  }
  if (shots) await page.screenshot({ path: join(shots, `${String(step).padStart(2, '0')}-${name.replace(/\W+/g, '-')}.png`) });
}

const composer = () => page.locator('.composer textarea');
async function send(text) {
  await composer().fill(text);
  await composer().press('Enter');
}
async function nav(label) {
  await page.locator('.nav-item', { hasText: label }).first().click();
}

let failed = false;
try {
  console.log(`Kronos e2e — fresh install ${freshGw.url}`);
  await check('first launch asks to connect a model provider', async () => {
    await page.goto(`${freshGw.url}/?token=e2e-token`);
    await page.locator('.welcome-title', { hasText: 'KRONOS AGENT' }).waitFor({ timeout: 15000 });
    await page.locator('.welcome .connect-card', { hasText: 'Connect a model to get started' }).waitFor({ timeout: 5000 });
    await page.locator('.welcome .connect-chip', { hasText: 'Connect a model' }).waitFor({ timeout: 5000 });
    if (await page.locator('.welcome-demo, .me-model:not(.connect-chip)').count()) throw new Error('a demo/model chip is still offered');
  });
  await check('a message without a provider is kept, with a connect prompt under it', async () => {
    await send('Hello Kronos!');
    await page.locator('.user-msg', { hasText: 'Hello Kronos!' }).first().waitFor({ timeout: 10000 });
    const card = page.locator('.thread .connect-card.attention', { hasText: 'No model provider connected' });
    await card.waitFor({ timeout: 5000 });
    await card.locator('.connect-btn', { hasText: 'Connect a provider' }).waitFor();
    if (await page.locator('.assistant-turn').count()) throw new Error('something answered without a provider');
  });
  await check('the connect button opens Providers & API keys', async () => {
    await page.locator('.thread .connect-card .connect-btn', { hasText: 'Connect a provider' }).click();
    await page.locator('.settings-nav-item.active', { hasText: /Providers/ }).waitFor({ timeout: 5000 });
    const openaiTile = page.locator('.pv-tile', { has: page.locator('.pv-name', { hasText: /^OpenAI$/ }) });
    await openaiTile.click();
    await page.locator('.pv-panel input[type="password"]').fill('sk-good');
    await page.locator('.pv-panel .btn.primary').first().click();
    await page.locator('.pv-result.ok').waitFor({ timeout: 10000 });
    await page.keyboard.press('Escape');
  });
  await check('once connected, the kept message gets its answer', async () => {
    await page.locator('.thread .connect-card .connect-btn', { hasText: 'Answer now' }).click();
    await page.locator('.assistant-turn', { hasText: 'Hi from the connected model' }).waitFor({ timeout: 10000 });
    await page.locator('.thread .connect-card').waitFor({ state: 'detached', timeout: 5000 });
    const users = await page.locator('.thread').getByText('Hello Kronos!', { exact: true }).count();
    if (users !== 1) throw new Error(`the message shows ${users} times`);
  });
  await freshGw.close();
  delete process.env.OPENAI_API_KEY;

  console.log(`Kronos e2e — ${gw.url}`);
  await check('loads the app', async () => {
    await page.goto(`${gw.url}/?token=e2e-token`);
    await page.locator('.welcome').waitFor({ timeout: 15000 });
  });
  await check('welcome screen: greeting and a minimal composer', async () => {
    await page.locator('.welcome-title', { hasText: 'KRONOS AGENT' }).waitFor({ timeout: 5000 });
    await page.locator('.welcome .composer textarea[placeholder="Message Kronos"]').waitFor({ timeout: 5000 });
    await page.locator('.welcome .me-effort', { hasText: 'Medium' }).waitFor({ timeout: 5000 });
  });
  await check('long menus scroll inside the window', async () => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.locator('.welcome .composer-bar .cbtn.icon').first().click();
    const box = await page.locator('.menu .plus-menu').evaluate((el) => {
      const menu = el.closest('.menu');
      const r = menu.getBoundingClientRect();
      return { bottom: r.bottom, scrolls: menu.scrollHeight > menu.clientHeight, vh: innerHeight };
    });
    if (box.bottom > box.vh || !box.scrolls) throw new Error(`menu does not fit/scroll: ${JSON.stringify(box)}`);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  await check('idle UI does no per-frame work', async () => {
    // regression guard: an always-on animation once forced ~60 style + layout passes a second
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    await page.waitForTimeout(500);
    const a = await read();
    await page.waitForTimeout(2000);
    const b = await read();
    const perSecond = (b.RecalcStyleCount - a.RecalcStyleCount + (b.LayoutCount - a.LayoutCount)) / 2;
    await cdp.detach();
    if (perSecond > 3) throw new Error(`idle UI restyles/lays out ${perSecond.toFixed(1)}×/s`);
  });
  await check('chats with the demo model', async () => {
    await send('Hello Kronos!');
    await page.locator('.assistant-turn').filter({ hasText: /Kronos/ }).first().waitFor({ timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('.assistant-turn.live'), null, { timeout: 15000 });
  });
  await check('runs tools and renders tool cards', async () => {
    await send('list the files here');
    await page.locator('.tool-card').first().waitFor({ timeout: 15000 });
    await page.locator('.assistant-turn', { hasText: 'README.md' }).first().waitFor({ timeout: 15000 });
  });
  await check('session appears in the sidebar', async () => {
    await page.locator('.session-item').first().waitFor({ timeout: 10000 });
  });
  await check('plans with a todo list and a progress rail', async () => {
    await send('make a plan to refactor app.ts');
    await page.locator('.tool-card .todo-list').first().waitFor({ timeout: 15000 });
    await page.locator('.progress-rail .todo-list').waitFor({ timeout: 15000 });
  });
  await check('summarises file changes with undo', async () => {
    await send('create file notes.md');
    await page.locator('.files-changed', { hasText: 'notes.md' }).waitFor({ timeout: 15000 });
    await page.locator('.fc-undo').click();
    await page.locator('.files-changed').waitFor({ state: 'detached', timeout: 15000 });
  });
  await check('switches permission mode from the composer', async () => {
    await page.locator('.composer-bar .cbtn[class*="mode-"]').click();
    await page.locator('.mode-option', { hasText: 'Plan mode' }).click();
    await page.locator('.composer-bar .cbtn.mode-plan').waitFor({ timeout: 5000 });
  });
  for (const [label, sel] of [
    ['Skills', '.page'],
    ['Messaging', '.page'],
    ['Artifacts', '.page'],
    ['Automations', '.page'],
    ['Memory', '.page'],
    ['Insights', '.page'],
  ]) {
    await check(`opens ${label}`, async () => {
      await nav(label);
      await page.locator(sel).first().waitFor({ timeout: 10000 });
    });
  }
  await check('opens settings and switches theme', async () => {
    await page.keyboard.press('Control+,');
    await page.locator('.settings').first().waitFor({ timeout: 10000 });
    await page.locator('.settings-nav-item', { hasText: /Appearance|Görünüm/ }).click();
    await page.locator('.theme-card, .theme-swatch').nth(2).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme && document.documentElement.dataset.theme !== 'kronos', null, { timeout: 5000 });
    await page.keyboard.press('Escape');
  });
  await check('connects a provider from settings', async () => {
    await page.keyboard.press('Control+,');
    await page.locator('.settings-nav-item', { hasText: /Providers/ }).click();
    const openaiTile = page.locator('.pv-tile', { has: page.locator('.pv-name', { hasText: /^OpenAI$/ }) });
    await openaiTile.click();
    const keyInput = page.locator('.pv-panel input[type="password"]');
    await keyInput.fill('sk-wrong');
    await page.locator('.pv-panel .btn.primary').first().click();
    await page.locator('.pv-result.error', { hasText: /rejected/ }).waitFor({ timeout: 10000 });
    await keyInput.fill('sk-good');
    await page.locator('.pv-panel .btn.primary').first().click();
    await page.locator('.pv-result.ok').waitFor({ timeout: 10000 });
    await page.locator('.pv-panel select').selectOption('openai:gpt-fake-large');
    await page.locator('.pv-panel .btn.primary', { hasText: /default/i }).click();
    await page.waitForFunction(async () => {
      const r = await fetch('/api/config', { headers: { authorization: 'Bearer e2e-token' } });
      return (await r.json()).config.model.default === 'openai:gpt-fake-large';
    }, null, { timeout: 5000 });
    await openaiTile.locator('.pv-state.on').waitFor();
    await page.keyboard.press('Escape');
  });
  await check('command palette', async () => {
    await page.keyboard.press('Control+k');
    await page.locator('.palette input').waitFor();
    await page.locator('.palette input').fill('memory');
    await page.locator('.palette-item').first().waitFor();
    await page.keyboard.press('Escape');
  });
  await check('files panel', async () => {
    await page.keyboard.press('Control+j');
    await page.locator('.right-panel').waitFor({ timeout: 10000 });
    await page.locator('.right-panel', { hasText: 'README.md' }).waitFor({ timeout: 10000 });
  });
  await check('terminal panel', async () => {
    await page.locator('.right-tabs button[title="Terminal"]').click();
    await page.locator('.xterm').waitFor({ timeout: 10000 });
  });
  if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`);
  console.log(`\nAll ${step} UI checks passed.`);
} catch (e) {
  failed = true;
  if (errors.length) console.log(`\nBrowser errors:\n  ${errors.join('\n  ')}`);
  console.error(`\nE2E failed: ${e.message}`);
} finally {
  await browser.close();
  fakeApi.close();
  await gw.close();
  await freshGw.close().catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
  rmSync(freshHome, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
