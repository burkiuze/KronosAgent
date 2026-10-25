#!/usr/bin/env node
// Resource benchmark: how much CPU and memory the UI and the gateway use.
//   idle UI      — main-thread time, layout / style passes and renderer CPU with nothing happening
//   streaming    — the same while a fast model streams a long Markdown answer (fake OpenAI server)
//   gateway      — RSS / heap after start and after 20 turns, and idle CPU
// Usage: npm run build && npm run bench      (KRONOS_UI_DIR=<dist> to measure another UI build)
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Kronos } from '@kronos/core';
import { Gateway } from '@kronos/gateway';

for (const k of Object.keys(process.env)) if (/_API_KEY$|^ANTHROPIC_AUTH_TOKEN$/.test(k)) delete process.env[k];
process.env.OPENAI_API_KEY = 'sk-bench';
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ~8 KB of mixed Markdown streamed in 6-character chunks every 3 ms (~330 deltas/s)
const para = 'Kronos streams this paragraph to measure how much work the interface does per token. It includes **bold**, `inline code` and a [link](https://example.com). ';
let answer = '';
for (let i = 0; i < 14; i++) {
  answer += `## Section ${i + 1}\n\n${para.repeat(3)}\n\n- first point about ${i}\n- second point\n- third point\n\n`;
  if (i % 3 === 0) answer += '```ts\nexport function total(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}\n```\n\n';
}
const fakeApi = createServer((req, res) => {
  if (!req.url.includes('chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"gpt-bench"}]}');
    return;
  }
  req.resume();
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (choice) => res.write(`data: ${JSON.stringify({ id: 'b', object: 'chat.completion.chunk', created: 0, model: 'gpt-bench', choices: [choice] })}\n\n`);
  let i = 0;
  const timer = setInterval(() => {
    if (i >= answer.length) {
      clearInterval(timer);
      chunk({ index: 0, delta: {}, finish_reason: 'stop' });
      res.end('data: [DONE]\n\n');
      return;
    }
    chunk({ index: 0, delta: { content: answer.slice(i, i + 6) }, finish_reason: null });
    i += 6;
  }, 3);
});
await new Promise((r) => fakeApi.listen(0, '127.0.0.1', r));

const runtime = (model) =>
  Kronos.create({
    home: mkdtempSync(join(tmpdir(), 'kronos-bench-home-')),
    cwd: mkdtempSync(join(tmpdir(), 'kronos-bench-ws-')),
    connectMcp: false,
    logLevel: 'silent',
    overrides: { model: { default: model }, providers: { openai: { baseUrl: `http://127.0.0.1:${fakeApi.address().port}/v1` } }, skills: { claudeCompat: false }, ui: { mode: 'dark' } },
  });

const gatewayOnly = process.argv.includes('--gateway');

// ------------------------------------------------------------------ UI
if (!gatewayOnly) {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const rt = await runtime('kronos:demo');
  const gw = await Gateway.start(rt, { port: 0, host: '127.0.0.1', platforms: false, cron: false, token: 'bench', quiet: true });
  const browser = await chromium.launch();
  const bcdp = await browser.newBrowserCDPSession();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const rendererCpu = async () => (await bcdp.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer').reduce((n, p) => n + p.cpuTime, 0);
  const measure = async (label, during) => {
    const a = await metrics();
    const ca = await rendererCpu();
    const t0 = Date.now();
    await during();
    const secs = (Date.now() - t0) / 1000;
    const b = await metrics();
    const cb = await rendererCpu();
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = (await metrics()).JSHeapUsedSize;
    const per = (k) => (b[k] - a[k]) / secs;
    console.log(
      `${label.padEnd(22)} main thread ${(per('TaskDuration') * 1000).toFixed(0).padStart(4)} ms/s · layouts ${per('LayoutCount').toFixed(1).padStart(5)}/s · style recalcs ${per('RecalcStyleCount').toFixed(1).padStart(5)}/s · renderer CPU ${(((cb - ca) / secs) * 100).toFixed(1).padStart(5)}% · JS heap ${mb(heap)}`,
    );
  };
  await page.goto(`${gw.url}/?token=bench`);
  await page.locator('.welcome').waitFor();
  await sleep(1500);
  await measure('UI idle (welcome)', () => sleep(5000));
  for (const text of ['Hello Kronos!', 'list the files here', 'make a plan to add a discount feature']) {
    await page.fill('.composer textarea', text);
    await page.press('.composer textarea', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.assistant-turn.live'), null, { timeout: 30000 });
  }
  await sleep(1500);
  await measure('UI idle (chat)', () => sleep(5000));
  await page.evaluate(() => (location.hash = ''));
  await page.locator('.nav-item', { hasText: 'New agent' }).first().click();
  await page.locator('.welcome').waitFor();
  await rt.updateConfig({ model: { default: 'openai:gpt-bench' } });
  await page.reload();
  await page.locator('.welcome').waitFor();
  await sleep(1000);
  await page.fill('.composer textarea', 'Write the long answer');
  await measure(`UI streaming ${(answer.length / 1024).toFixed(0)} KB`, async () => {
    await page.press('.composer textarea', 'Enter');
    await page.locator('.assistant-turn.live').waitFor();
    if (process.env.BENCH_PROBE) {
      await sleep(600);
      console.log(await page.evaluate(() => document.getAnimations().map((a) => `${a.animationName} on ${a.effect?.target?.className?.baseVal ?? a.effect?.target?.className}`)));
    }
    await page.waitForFunction(() => !document.querySelector('.assistant-turn.live'), null, { timeout: 120000 });
  });
  await browser.close();
  await gw.close();
  await rt.close();
}

// ------------------------------------------------------------------ gateway
// measured in a fresh process so the browser driver above does not count against it
if (!gatewayOnly) {
  process.stdout.write(execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--gateway'], { encoding: 'utf8' }));
} else {
  global.gc?.();
  const rt = await runtime('kronos:demo');
  const gw = await Gateway.start(rt, { port: 0, host: '127.0.0.1', platforms: false, cron: true, token: 'bench', quiet: true });
  global.gc?.();
  const started = process.memoryUsage();
  for (let i = 0; i < 10; i++) for (const text of ['hello', 'list the files here']) await rt.runHeadless(text, { source: 'api' });
  await sleep(1500);
  global.gc?.();
  const after = process.memoryUsage();
  const cpu0 = process.cpuUsage();
  await sleep(10_000);
  const cpu = process.cpuUsage(cpu0);
  console.log(`gateway                started RSS ${mb(started.rss)} heap ${mb(started.heapUsed)} · after 20 turns RSS ${mb(after.rss)} heap ${mb(after.heapUsed)} · idle CPU ${((cpu.user + cpu.system) / 10_000).toFixed(1)} ms/s`);
  await gw.close();
  await rt.close();
}
fakeApi.close();
