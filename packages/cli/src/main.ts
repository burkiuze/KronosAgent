import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  Kronos,
  KRONOS_VERSION,
  catalogModels,
  coerceValue,
  formatCost,
  formatTokens,
  getPath,
  listProfiles,
  parseEvalSuite,
  evalConfigs,
  runEvalSuite,
  maskSecrets,
  serveMcp,
  setActiveProfile,
  updateDotenv,
  ensureProfile,
  kronosHome,
  profileDir,
  type AgentEvent,
  type PermissionMode,
} from '@kronos/core';
import { Gateway, exportMarkdown } from '@kronos/gateway';
import { parseArgs, flagStr, type ParsedArgs } from './args.js';
import { Repl } from './repl.js';
import { runSetup } from './setup.js';
import { importFrom } from './importers.js';
import { EventRenderer } from './ui/render.js';
import { c, logo, sym } from './ui/ansi.js';

const HELP = `${c.bold('KRONOS AGENT')} v${KRONOS_VERSION} — the self-improving autonomous agent

${c.bold('Usage')}
  kronos [prompt]                 interactive session (optionally start with a prompt)
  kronos run "<prompt>"           one-shot, non-interactive run (prints the answer)
  kronos web                      start the gateway and open the desktop UI in your browser
  kronos desktop                  launch the Kronos desktop app
  kronos gateway                  run the gateway: desktop/web backend, messaging, cron, API
  kronos setup                    interactive setup wizard

${c.bold('Manage')}
  kronos model [list|set <ref>]   models & providers        kronos keys [list|set|unset]
  kronos config [show|get|set|path|edit]                    kronos profile [list|create|use|delete]
  kronos skills [list|show|enable|disable|install|create|history|rollback|prune]
  kronos sessions [list|show|export|delete|search]          kronos eval <suite.yaml> [--repeats N] [--model a,b] [--effort low,high] [--out report.json]
  kronos cron [list|add|remove|run|pause|resume]            kronos memory [show|add|search|clear]
  kronos mcp [list|add|remove|serve]                        kronos pairing [list|approve <code>]
  kronos import <hermes|openclaw|claude|codex|cursor>       kronos insights [--days N]
  kronos doctor · kronos version · kronos update [--check]

${c.bold('Options')}
  -m, --model <ref>     model (e.g. sonnet, anthropic:claude-opus-5-5, ollama:qwen3-coder:30b)
  -p, --profile <name>  profile to use            -C, --cwd <dir>      working directory
  -s, --session <id>    resume a session          -c, --continue       resume the latest CLI session
  --mode <m>            ask | auto-edit | yolo | plan   (-y = yolo, --plan = plan)
  --skill <name>        preload a skill (run)     --json               JSON output (run)
  -v, --verbose         technical tool output     -h, --help           this help
`;

async function makeRuntime(args: ParsedArgs, opts: { startCron?: boolean; connectMcp?: boolean } = {}): Promise<Kronos> {
  const profile = flagStr(args, 'profile');
  const cwd = flagStr(args, 'cwd');
  return Kronos.create({ profile, cwd: cwd ? resolve(cwd) : undefined, startCron: opts.startCron, connectMcp: opts.connectMcp, logLevel: args.flags.verbose ? 'info' : 'warn' });
}

function modeFrom(args: ParsedArgs): PermissionMode | undefined {
  if (args.flags.yolo) return 'yolo';
  if (args.flags.plan) return 'plan';
  const m = flagStr(args, 'mode');
  return m && ['ask', 'auto-edit', 'yolo', 'plan'].includes(m) ? (m as PermissionMode) : undefined;
}

/**
 * Read piped input. When a prompt was already given on the command line, only wait briefly for
 * the first chunk, so an idle pipe that never closes (CI runners, process managers) can't hang.
 */
async function readStdin(opts: { idleMs?: number } = {}): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolveRead) => {
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const finish = (gaveUp = false) => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onEnd);
      if (gaveUp) process.stdin.destroy();
      resolveRead(Buffer.concat(chunks).toString('utf8'));
    };
    const onEnd = () => finish();
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      clearTimeout(timer);
      timer = undefined;
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onEnd);
    if (opts.idleMs) timer = setTimeout(() => finish(true), opts.idleMs);
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* headless */
  }
}

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').replace(/\x1b\[[0-9;]*m/g, '').length))) ?? [];
  return rows.map((r) => r.map((cell, i) => cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - cell.replace(/\x1b\[[0-9;]*m/g, '').length))).join('  ')).join('\n');
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [cmd, ...pos] = args._;

  if (args.flags.version || cmd === 'version') {
    console.log(`kronos-agent ${KRONOS_VERSION} (node ${process.versions.node})`);
    return;
  }
  if (args.flags.help || cmd === 'help') {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case 'run':
      return cmdRun(args, pos);
    case 'eval':
      return withRt(args, (rt) => cmdEval(rt, pos, args));
    case 'gateway':
    case 'serve':
      return cmdGateway(args, false);
    case 'web':
      return cmdGateway(args, true);
    case 'desktop':
      return cmdDesktop(args);
    case 'setup':
      return withRt(args, (rt) => runSetup(rt));
    case 'model':
    case 'models':
      return withRt(args, (rt) => cmdModel(rt, pos));
    case 'config':
      return withRt(args, (rt) => cmdConfig(rt, pos));
    case 'keys':
      return withRt(args, (rt) => cmdKeys(rt, pos));
    case 'skills':
    case 'skill':
      return withRt(args, (rt) => cmdSkills(rt, pos, args));
    case 'sessions':
    case 'session':
      return withRt(args, (rt) => cmdSessions(rt, pos, args));
    case 'cron':
      return withRt(args, (rt) => cmdCron(rt, pos, args), { startCron: false });
    case 'memory':
      return withRt(args, (rt) => cmdMemory(rt, pos, args));
    case 'profile':
    case 'profiles':
      return cmdProfile(args, pos);
    case 'mcp':
      return cmdMcp(args, pos);
    case 'pairing':
      return withRt(args, (rt) => cmdPairing(rt, pos));
    case 'import':
      return withRt(args, (rt) => cmdImport(rt, pos, args));
    case 'doctor':
      return withRt(args, async (rt) => {
        console.log(c.bold('\nKronos doctor\n'));
        for (const r of await rt.doctor()) console.log(`  ${r.ok ? c.green(sym.ok) : c.yellow(sym.warn)} ${r.check.padEnd(22)} ${c.gray(r.detail)}`);
        console.log();
      });
    case 'insights':
    case 'usage':
      return withRt(args, (rt) => cmdInsights(rt, args));
    case 'update':
      return cmdUpdate(args);
    case 'chat':
    case undefined:
      return cmdInteractive(args, pos.join(' '));
    default:
      // `kronos "do something"` → interactive session seeded with the prompt
      return cmdInteractive(args, [cmd, ...pos].join(' '));
  }
}

async function withRt(args: ParsedArgs, fn: (rt: Kronos) => Promise<void> | void, opts: { startCron?: boolean } = {}): Promise<void> {
  const rt = await makeRuntime(args, { connectMcp: false, ...opts });
  try {
    await fn(rt);
  } finally {
    await rt.close();
  }
}

async function cmdInteractive(args: ParsedArgs, prompt: string): Promise<void> {
  const piped = await readStdin({ idleMs: prompt ? 400 : undefined });
  const rt = await makeRuntime(args);
  let sessionId = flagStr(args, 'session');
  if (args.flags.continue) sessionId = rt.sessions.list({ limit: 1, source: 'cli' })[0]?.id;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // non-interactive environment: behave like `run`
    await rt.close();
    return cmdRun(args, [prompt, piped].filter(Boolean));
  }
  const repl = new Repl(rt, { sessionId, initialPrompt: prompt || undefined, model: flagStr(args, 'model'), mode: modeFrom(args), verbose: Boolean(args.flags.verbose) });
  await repl.start();
}

async function cmdRun(args: ParsedArgs, pos: string[]): Promise<void> {
  const piped = await readStdin({ idleMs: pos.join('').trim() ? 400 : undefined });
  const prompt = [pos.join(' '), piped ? `\n\n<stdin>\n${piped}\n</stdin>` : ''].join('').trim();
  if (!prompt) {
    console.error('usage: kronos run "<prompt>"  (or pipe input)');
    process.exitCode = 2;
    return;
  }
  const rt = await makeRuntime(args);
  const json = Boolean(args.flags.json);
  const renderer = json ? undefined : new EventRenderer({ verbose: Boolean(args.flags.verbose), showThinking: false, write: (s) => process.stderr.write(s) });
  let streamedText = '';
  const onEvent = (e: AgentEvent) => {
    if (json) return;
    if (e.type === 'text_delta') {
      process.stdout.write(e.text);
      streamedText += e.text;
      return;
    }
    if ((e.type === 'turn_start' || e.type === 'tool_call') && streamedText && !streamedText.endsWith('\n')) {
      process.stdout.write('\n');
      streamedText += '\n';
    }
    if (['tool_call', 'tool_result', 'notice', 'subagent', 'todos'].includes(e.type)) renderer?.handle(e);
  };
  const ctl = new AbortController();
  process.on('SIGINT', () => ctl.abort());
  try {
    const res = await rt.runHeadless(prompt, {
      sessionId: flagStr(args, 'session'),
      model: flagStr(args, 'model'),
      mode: modeFrom(args) ?? (rt.config.safety.mode === 'ask' ? 'auto-edit' : rt.config.safety.mode),
      source: 'cli',
      autoApprove: Boolean(args.flags.yolo),
      preloadSkills: flagStr(args, 'skill')?.split(','),
      signal: ctl.signal,
      onEvent,
    });
    if (json) console.log(JSON.stringify({ text: res.text, stopReason: res.stopReason, sessionId: res.sessionId, usage: res.usage, durationMs: res.durationMs, error: res.error }, null, 2));
    else {
      if (!streamedText.endsWith('\n')) process.stdout.write('\n');
      if (res.error) console.error(c.red(`${sym.fail} ${res.error}`));
    }
    if (res.stopReason === 'error') process.exitCode = 1;
  } finally {
    await rt.close();
  }
}

async function cmdGateway(args: ParsedArgs, openUi: boolean): Promise<void> {
  const rt = await makeRuntime(args, { startCron: true });
  const portFlag = flagStr(args, 'port');
  const gw = await Gateway.start(rt, {
    host: flagStr(args, 'host'),
    port: portFlag ? Number(portFlag) : undefined,
    token: flagStr(args, 'token'),
    platforms: args.flags.platforms !== false,
  });
  // a wildcard bind isn't a browsable address — show localhost instead
  const base = gw.url.replace(/\/\/(0\.0\.0\.0|\[::\])(?=:)/, '//localhost');
  const url = `${base}${gw.token ? `/?token=${encodeURIComponent(gw.token)}` : '/'}`;
  console.log(`\n${logo()}\n`);
  console.log(`  ${c.bold('Gateway')}      ${c.cyan(url)}`);
  console.log(`  ${c.bold('Profile')}      ${rt.profile}   ${c.bold('Model')} ${rt.providers.resolve().ref}`);
  if (rt.config.gateway.openaiApi) console.log(`  ${c.bold('OpenAI API')}   ${base}/v1  ${c.gray('(model: kronos)')}`);
  const plats = gw.platforms.statuses().filter((p) => p.enabled);
  console.log(`  ${c.bold('Messaging')}    ${plats.length ? plats.map((p) => `${p.label}: ${p.state === 'running' ? c.green(p.state) : c.yellow(p.state)}`).join(', ') : c.gray('none enabled (Settings → Gateway)')}`);
  console.log(`  ${c.bold('Automations')}  ${rt.cron.list().filter((j) => j.enabled).length} active`);
  console.log(c.gray('\n  Ctrl+C to stop\n'));
  if (openUi && !args.flags['no-open']) openBrowser(url);
  const shutdown = async () => {
    console.log(c.gray('\nstopping…'));
    await gw.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise(() => undefined);
}

async function cmdDesktop(args: ParsedArgs): Promise<void> {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const appDir = resolve(here, '../../../apps/desktop');
  const electronBin = join(appDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const rootElectron = resolve(here, '../../../node_modules/.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const bin = existsSync(electronBin) ? electronBin : existsSync(rootElectron) ? rootElectron : null;
  if (!bin || !existsSync(join(appDir, 'dist', 'main.cjs'))) {
    console.log(c.yellow('The native desktop shell is not built here — opening the same UI in your browser instead.'));
    console.log(c.gray('  Build it with: npm run build && npm run build:desktop'));
    return cmdGateway(args, true);
  }
  spawn(bin, [appDir], { stdio: 'inherit', detached: false });
}

async function cmdModel(rt: Kronos, pos: string[]): Promise<void> {
  const [sub, ref] = pos;
  if (sub === 'set' && ref) {
    const info = rt.providers.resolve(ref);
    rt.updateConfig({ model: { default: info.ref } });
    console.log(`${c.green(sym.ok)} default model → ${info.name} (${info.ref})`);
    return;
  }
  const current = rt.providers.resolve();
  console.log(`${c.bold('Default:')} ${current.name} ${c.gray(`(${current.ref})`)}\n`);
  const statuses = rt.providers.statuses();
  console.log(table([[c.bold('Provider'), c.bold('Status'), c.bold('Key / URL')], ...statuses.map((p) => [p.label, p.configured ? c.green('ready') : c.gray('not configured'), c.gray(p.envKeys.join(' / ') || p.baseUrl)])]));
  if (sub === 'list') {
    console.log();
    const ready = new Set(statuses.filter((s) => s.configured).map((s) => s.id));
    for (const m of catalogModels().filter((x) => ready.has(x.provider))) console.log(`  ${c.gold(m.ref.padEnd(44))} ${m.name}${m.description ? c.gray(` — ${m.description}`) : ''}`);
  }
  console.log(c.gray('\n  kronos model set <ref>   ·   any OpenAI-compatible model works: kronos model set openrouter:<vendor/model>'));
}

async function cmdConfig(rt: Kronos, pos: string[]): Promise<void> {
  const [sub, key, ...rest] = pos;
  switch (sub) {
    case 'get':
      console.log(JSON.stringify(maskSecrets(getPath(rt.rawConfig, key ?? '')), null, 2));
      return;
    case 'set': {
      if (!key) throw new Error('usage: kronos config set <key> <value>');
      rt.setConfig(key, coerceValue(rest.join(' ')));
      console.log(`${c.green(sym.ok)} ${key} = ${JSON.stringify(getPath(rt.rawConfig, key))}`);
      return;
    }
    case 'path':
      console.log(rt.configFile());
      return;
    case 'edit': {
      const editor = process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'nano');
      if (!existsSync(rt.configFile())) writeFileSync(rt.configFile(), '# Kronos configuration — see docs/CONFIGURATION.md\n');
      spawn(editor, [rt.configFile()], { stdio: 'inherit' });
      return;
    }
    default:
      console.log(YAML.stringify(maskSecrets(rt.rawConfig)));
  }
}

async function cmdKeys(rt: Kronos, pos: string[]): Promise<void> {
  const [sub, name, value] = pos;
  const file = join(rt.home, '.env');
  if (sub === 'set' && name) {
    let v = value;
    if (!v) {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      v = (await rl.question(`${name}: `)).trim();
      rl.close();
    }
    updateDotenv(file, { [name]: v });
    console.log(`${c.green(sym.ok)} ${name} saved to ${file}`);
    return;
  }
  if (sub === 'unset' && name) {
    updateDotenv(file, { [name]: null });
    console.log(`${c.green(sym.ok)} ${name} removed`);
    return;
  }
  for (const p of rt.providers.statuses()) {
    for (const k of p.envKeys) console.log(`  ${process.env[k] ? c.green('●') : c.gray('○')} ${k.padEnd(24)} ${c.gray(p.label)}`);
  }
  console.log(c.gray(`\n  stored in ${file} · kronos keys set NAME [value]`));
}

async function cmdSkills(rt: Kronos, pos: string[], args: ParsedArgs): Promise<void> {
  const [sub, name, ...rest] = pos;
  switch (sub) {
    case 'show': {
      const { info, content } = rt.skills.read(name ?? '');
      console.log(`${c.bold(info.name)} ${c.gray(`[${info.category}] ${info.source} · ${info.path}`)}\n\n${content}`);
      return;
    }
    case 'enable':
    case 'disable':
      rt.setSkillEnabled(name ?? '', sub === 'enable');
      console.log(`${c.green(sym.ok)} ${name} ${sub}d`);
      return;
    case 'install': {
      const list = await rt.skills.install(name ?? '', { category: flagStr(args, 'category') });
      console.log(`${c.green(sym.ok)} installed ${list.map((s) => s.name).join(', ')}`);
      return;
    }
    case 'create': {
      const description = flagStr(args, 'description') ?? rest.join(' ');
      const s = rt.skills.create({ name: name ?? 'new-skill', description: description || 'Describe when to use this skill', body: '# Steps\n\n1. …\n', category: flagStr(args, 'category') });
      console.log(`${c.green(sym.ok)} created ${s.path}`);
      return;
    }
    case 'path':
      console.log(rt.paths.skills);
      return;
    case 'history': {
      const current = rt.skills.get(name ?? '');
      const revs = rt.skills.history(name ?? '');
      console.log(`${c.bold(name ?? '')} ${c.gray(current ? `current v${current.version ?? '1.0.0'}` : 'deleted')}`);
      for (const r of revs) console.log(`  v${r.version.padEnd(10)} ${new Date(r.savedAt).toISOString().slice(0, 16).replace('T', ' ')}  ${c.gray(r.reason)}`);
      if (!revs.length) console.log(c.gray('  no earlier versions'));
      return;
    }
    case 'rollback': {
      const s = rt.skills.rollback(name ?? '', rest[0] ?? flagStr(args, 'version'));
      console.log(`${c.green(sym.ok)} ${s.name} restored to v${s.version}`);
      return;
    }
    case 'prune': {
      const list = rt.skillPruneCandidates();
      if (!list.length) {
        console.log(c.gray('Nothing to prune: every agent-written skill is in use and mostly succeeding.'));
        return;
      }
      for (const p of list) console.log(`  ${c.gold(p.name.padEnd(28))} ${p.reason} ${c.gray(`(${p.uses} uses · ${p.ok} ok · ${p.failed} failed)`)}`);
      if (args.flags.apply) {
        for (const p of list) rt.skills.delete(p.name);
        console.log(`${c.green(sym.ok)} removed ${list.length} skill(s); \`kronos skills rollback <name>\` restores any of them`);
      } else console.log(c.gray('\nRun with --apply to remove them (each stays restorable with `kronos skills rollback <name>`).'));
      return;
    }
    default: {
      const list = rt.skills.list({ includeDisabled: true });
      let cat = '';
      for (const s of list) {
        if (s.category !== cat) {
          cat = s.category;
          console.log(c.bold(`\n${cat}`));
        }
        console.log(`  ${s.enabled ? c.green('●') : c.gray('○')} ${c.gold(s.name.padEnd(28))} ${c.gray(s.description.slice(0, 90))}`);
      }
      console.log(c.gray(`\n${list.length} skills · user skills in ${rt.paths.skills}`));
    }
  }
}

/**
 * Run an evaluation suite: every case × repeat × (model, effort) in a fresh, isolated runtime,
 * then report pass rate with its run-to-run spread, tokens, cost, time and tool calls.
 */
async function cmdEval(rt: Kronos, pos: string[], args: ParsedArgs): Promise<void> {
  const file = pos[0];
  if (!file || !existsSync(file)) throw new Error('usage: kronos eval <suite.yaml> [--repeats N] [--model a,b] [--effort low,high] [--out report.json]');
  const suite = parseEvalSuite(readFileSync(file, 'utf8'), file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''));
  const list = (v: string | undefined) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  const models = list(flagStr(args, 'model'));
  const efforts = list(flagStr(args, 'effort'));
  if (models) suite.matrix.model = models;
  if (efforts) suite.matrix.effort = efforts as typeof suite.matrix.effort;
  const repeats = flagStr(args, 'repeats') ? Math.max(1, Number(flagStr(args, 'repeats'))) : suite.repeats;
  const configs = evalConfigs(suite, { model: rt.config.model.default, effort: rt.config.model.effort });
  const total = configs.length * suite.cases.length * repeats;
  console.log(`${c.bold(`Eval: ${suite.name}`)} ${c.gray(`${suite.cases.length} case(s) × ${repeats} repeat(s) × ${configs.length} config(s) = ${total} runs`)}`);
  const base = rt.config;
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    const { runs, summary } = await runEvalSuite(suite, configs, {
      repeats,
      signal: controller.signal,
      // isolated home per run: no memory, skills or sessions carry over between runs
      createRuntime: (cfg, home) =>
        Kronos.create({
          home,
          cwd: home,
          connectMcp: false,
          logLevel: 'silent',
          overrides: {
            model: { ...base.model, default: cfg.model, effort: cfg.effort },
            providers: base.providers,
            customProviders: base.customProviders,
            skills: { ...base.skills, claudeCompat: false },
            memory: { ...base.memory, autoExtract: false },
            agent: { ...base.agent, autoTitle: false },
          },
        }),
      onRun: (r, p) => {
        const mark = r.passed ? c.green(sym.ok) : c.red('✗');
        const why = r.passed ? '' : c.gray(` — ${r.error ?? r.checks.filter((x) => !x.ok).map((x) => x.label).join(', ')}`);
        console.log(`  ${c.gray(`[${p.done}/${p.total}]`)} ${mark} ${r.case} ${c.gray(`· ${r.config} · #${r.repeat} · ${(r.durationMs / 1000).toFixed(1)}s · ${formatTokens(r.tokens)} tok`)}${why}`);
      },
    });
    const rows = [['config', 'pass rate', '± sd', 'runs', 'tokens/run', 'cost/run', 'time/run', 'tool calls/run']];
    for (const s of summary)
      rows.push([
        s.config,
        `${(s.passRate * 100).toFixed(0)}%`,
        `${(s.stdev * 100).toFixed(0)}%`,
        String(s.runs),
        formatTokens(Math.round(s.meanTokens)),
        formatCost(s.meanCostUsd),
        `${(s.meanDurationMs / 1000).toFixed(1)}s`,
        s.meanToolCalls.toFixed(1),
      ]);
    console.log(`\n${table(rows)}`);
    if (repeats < 3) console.log(c.gray('\nTip: use --repeats 3 or more; the same configuration varies a lot between runs.'));
    const out = flagStr(args, 'out');
    if (out) {
      writeFileSync(out, JSON.stringify({ suite: suite.name, repeats, configs, summary, runs }, null, 2));
      console.log(c.gray(`report written to ${out}`));
    }
    if (args.flags.json) console.log(JSON.stringify({ summary }, null, 2));
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function cmdSessions(rt: Kronos, pos: string[], args: ParsedArgs): Promise<void> {
  const [sub, id] = pos;
  switch (sub) {
    case 'show': {
      const s = rt.sessions.get(id ?? '');
      if (!s) throw new Error('session not found');
      console.log(exportMarkdown(s, rt.sessions.messages(s.id)));
      return;
    }
    case 'export': {
      const s = rt.sessions.get(id ?? '');
      if (!s) throw new Error('session not found');
      const fmt = flagStr(args, 'format') ?? 'md';
      const out = fmt === 'json' ? JSON.stringify({ session: s, messages: rt.sessions.messages(s.id) }, null, 2) : exportMarkdown(s, rt.sessions.messages(s.id));
      const file = flagStr(args, 'out');
      if (file) {
        writeFileSync(file, out);
        console.log(`${c.green(sym.ok)} ${file}`);
      } else console.log(out);
      return;
    }
    case 'delete':
      rt.deleteSession(id ?? '');
      console.log(`${c.green(sym.ok)} deleted ${id}`);
      return;
    case 'search':
      for (const h of rt.sessions.search(pos.slice(1).join(' '), { limit: 20 })) console.log(`${c.gold(h.title)} ${c.gray(h.sessionId)}\n  ${c.gray(h.snippet)}`);
      return;
    default:
      console.log(
        table([
          [c.bold('ID'), c.bold('Title'), c.bold('Source'), c.bold('Messages'), c.bold('Cost'), c.bold('Updated')],
          ...rt.sessions.list({ limit: Number(flagStr(args, 'limit') ?? 30) }).map((s) => [c.gray(s.id), s.title.slice(0, 48), s.source, String(s.messageCount), formatCost(s.usage.costUsd ?? 0), new Date(s.updatedAt).toLocaleString()]),
        ]),
      );
  }
}

async function cmdCron(rt: Kronos, pos: string[], args: ParsedArgs): Promise<void> {
  const [sub, a, ...rest] = pos;
  switch (sub) {
    case 'add': {
      if (!a || !rest.length) throw new Error('usage: kronos cron add "<schedule>" "<prompt>" [--deliver telegram:<chat>] [--name x]');
      const job = rt.cron.create({ schedule: a, prompt: rest.join(' '), name: flagStr(args, 'name'), deliver: flagStr(args, 'deliver') ? { target: flagStr(args, 'deliver') } : undefined, model: flagStr(args, 'model'), cwd: rt.workspace() });
      console.log(`${c.green(sym.ok)} ${job.name} — ${job.description}; next ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : '—'} (${job.id})`);
      console.log(c.gray('  automations run while `kronos gateway` (or the desktop app) is running'));
      return;
    }
    case 'remove':
    case 'delete':
      console.log(rt.cron.remove(a ?? '') ? `${c.green(sym.ok)} removed` : 'not found');
      return;
    case 'pause':
    case 'resume':
      rt.cron.update(a ?? '', { enabled: sub === 'resume' });
      console.log(`${c.green(sym.ok)} ${sub}d`);
      return;
    case 'run': {
      console.log(c.gray('running…'));
      const r = await rt.cron.run(a ?? '');
      console.log(r.status === 'ok' ? r.output : c.red(r.output));
      return;
    }
    case 'history':
      for (const r of rt.cron.history(a, 20)) console.log(`${r.status === 'ok' ? c.green(sym.ok) : c.red(sym.fail)} ${new Date(r.startedAt).toLocaleString()} ${c.bold(r.name)}\n  ${c.gray(r.output.slice(0, 200).replace(/\n/g, ' '))}`);
      return;
    default: {
      const jobs = rt.cron.list();
      if (!jobs.length) return console.log(c.gray('No automations. kronos cron add "every day at 9am" "Summarize my inbox" --deliver telegram:home'));
      console.log(table([[c.bold('ID'), c.bold('Name'), c.bold('Schedule'), c.bold('Next'), c.bold('Last'), c.bold('Deliver')], ...jobs.map((j) => [c.gray(j.id), `${j.enabled ? '' : '(paused) '}${j.name}`, j.description, j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '—', j.lastStatus ?? '—', j.deliver?.target ?? 'session'])]));
    }
  }
}

async function cmdMemory(rt: Kronos, pos: string[], args: ParsedArgs): Promise<void> {
  const [sub, ...rest] = pos;
  const target = args.flags.user ? 'user' : 'memory';
  switch (sub) {
    case 'add': {
      const r = rt.memory.add(target, rest.join(' '));
      console.log(r.ok ? `${c.green(sym.ok)} ${r.message}` : c.red(r.message));
      return;
    }
    case 'search':
      for (const h of rt.memory.search(rest.join(' '))) console.log(`[${h.target}] ${h.entry}`);
      return;
    case 'clear':
      rt.memory.replaceAll(target, []);
      console.log(`${c.green(sym.ok)} cleared ${target}`);
      return;
    case 'path':
      console.log(rt.paths.memories);
      return;
    default:
      console.log(rt.memory.snapshot());
  }
}

async function cmdProfile(args: ParsedArgs, pos: string[]): Promise<void> {
  const home = kronosHome();
  const [sub, name] = pos;
  switch (sub) {
    case 'create':
      if (!name) throw new Error('usage: kronos profile create <name>');
      console.log(`${c.green(sym.ok)} created ${ensureProfile(home, name)}`);
      return;
    case 'use':
      if (!name || !listProfiles(home).includes(name)) throw new Error('unknown profile');
      setActiveProfile(home, name);
      console.log(`${c.green(sym.ok)} active profile → ${name}`);
      return;
    case 'delete': {
      if (!name || name === 'default') throw new Error('cannot delete that profile');
      const { rmSync } = await import('node:fs');
      rmSync(profileDir(home, name), { recursive: true, force: true });
      console.log(`${c.green(sym.ok)} deleted ${name}`);
      return;
    }
    default: {
      const rt = await makeRuntime(args, { connectMcp: false });
      for (const p of listProfiles(home)) {
        const soul = join(profileDir(home, p), 'SOUL.md');
        console.log(`${p === rt.profile ? c.gold('●') : ' '} ${c.bold(p.padEnd(16))} ${c.gray(existsSync(soul) ? readFileSync(soul, 'utf8').split('\n')[0]?.slice(0, 70) ?? '' : '')}`);
      }
      await rt.close();
    }
  }
}

async function cmdMcp(args: ParsedArgs, pos: string[]): Promise<void> {
  const [sub, name] = pos;
  if (sub === 'serve') {
    const rt = await makeRuntime(args, { connectMcp: true });
    await serveMcp(rt, { mode: modeFrom(args) });
    await rt.close();
    return;
  }
  const rt = await makeRuntime(args, { connectMcp: sub !== 'add' && sub !== 'remove' });
  try {
    if (sub === 'add') {
      if (!name) throw new Error('usage: kronos mcp add <name> -- <command> [args…]   |   kronos mcp add <name> --url <url>');
      const url = flagStr(args, 'url');
      const [command, ...cargs] = args.rest;
      if (!url && !command) throw new Error('give a command after -- or --url');
      rt.updateConfig({ mcp: { servers: { [name]: url ? { url, enabled: true } : { command, args: cargs, enabled: true } } } });
      const st = await rt.mcp.connect(name, rt.config.mcp.servers[name] ?? {});
      console.log(st.status === 'connected' ? `${c.green(sym.ok)} ${name}: ${st.tools.length} tools` : c.red(`${name}: ${st.error}`));
      return;
    }
    if (sub === 'remove') {
      const { readYamlFile, writeYamlFile } = await import('@kronos/core');
      const data = readYamlFile(rt.configFile()) as { mcp?: { servers?: Record<string, unknown> } };
      if (data.mcp?.servers) delete data.mcp.servers[name ?? ''];
      writeYamlFile(rt.configFile(), data);
      console.log(`${c.green(sym.ok)} removed ${name}`);
      return;
    }
    const st = rt.mcp.status();
    if (!st.length) console.log(c.gray('No MCP servers. kronos mcp add github -- npx -y @modelcontextprotocol/server-github'));
    for (const s of st) console.log(`${s.status === 'connected' ? c.green('●') : c.red('●')} ${c.bold(s.name)} ${c.gray(`${s.transport} · ${s.tools.length} tools${s.error ? ` · ${s.error}` : ''}`)}`);
  } finally {
    await rt.close();
  }
}

async function cmdPairing(rt: Kronos, pos: string[]): Promise<void> {
  const [sub, code] = pos;
  const base = `http://127.0.0.1:${rt.config.gateway.port}`;
  const headers: Record<string, string> = rt.config.gateway.token ? { authorization: `Bearer ${rt.config.gateway.token}` } : {};
  try {
    if (sub === 'approve' && code) {
      const res = await fetch(`${base}/api/pairing/${encodeURIComponent(code)}/approve`, { method: 'POST', headers });
      const j = (await res.json()) as { platform?: string; userId?: string; error?: string };
      console.log(res.ok ? `${c.green(sym.ok)} paired ${j.platform} user ${j.userId}` : c.red(j.error ?? 'failed'));
      return;
    }
    const res = await fetch(`${base}/api/platforms`, { headers });
    const j = (await res.json()) as { pairing: { code: string; platform: string; userId: string; userName?: string }[] };
    if (!j.pairing.length) console.log(c.gray('No pending pairing requests.'));
    for (const p of j.pairing) console.log(`  ${c.gold(p.code)}  ${p.platform}  ${p.userName ?? ''} (${p.userId})`);
  } catch {
    console.log(c.red('The gateway is not running. Start it with `kronos gateway`.'));
  }
}

async function cmdImport(rt: Kronos, pos: string[], args: ParsedArgs): Promise<void> {
  const source = pos[0];
  if (!source) throw new Error('usage: kronos import <hermes|openclaw|claude|codex|cursor> [--dry-run]');
  const dry = Boolean(args.flags['dry-run']);
  const r = importFrom(rt, source, dry);
  console.log(c.bold(`${dry ? 'Would import' : 'Imported'} from ${source}:`));
  for (const i of r.items) console.log(`  ${c.green(sym.ok)} ${i}`);
  for (const s of r.skipped) console.log(`  ${c.gray(`– ${s}`)}`);
  if (!r.items.length) console.log(c.gray('  nothing to import'));
}

async function cmdInsights(rt: Kronos, args: ParsedArgs): Promise<void> {
  const days = Number(flagStr(args, 'days') ?? 30);
  const since = Date.now() - days * 86400_000;
  const byModel = rt.sessions.usageSummary({ since, groupBy: 'model' });
  const byDay = rt.sessions.usageSummary({ since, groupBy: 'day' });
  const total = byModel.reduce((a, r) => ({ cost: a.cost + r.costUsd, inTok: a.inTok + r.inputTokens + r.cacheReadTokens, outTok: a.outTok + r.outputTokens, req: a.req + r.requests, tools: a.tools + r.toolCalls }), { cost: 0, inTok: 0, outTok: 0, req: 0, tools: 0 });
  const sessions = rt.sessions.list({ limit: 10000, includeChildren: true }).filter((s) => s.updatedAt >= since);
  console.log(c.bold(`\nKronos insights — last ${days} days\n`));
  console.log(`  Sessions ${c.bold(String(sessions.length))} · Requests ${c.bold(String(total.req))} · Tool calls ${c.bold(String(total.tools))}`);
  console.log(`  Tokens ${c.bold(formatTokens(total.inTok))} in / ${c.bold(formatTokens(total.outTok))} out · Cost ${c.bold(formatCost(total.cost))}\n`);
  const max = Math.max(1, ...byDay.map((d) => d.outputTokens + d.inputTokens));
  for (const d of byDay.slice(-14)) console.log(`  ${d.key}  ${c.gold('█'.repeat(Math.max(1, Math.round(((d.outputTokens + d.inputTokens) / max) * 40))))} ${c.gray(formatCost(d.costUsd))}`);
  console.log();
  for (const m of byModel) console.log(`  ${m.key.padEnd(42)} ${formatCost(m.costUsd).padStart(9)}  ${c.gray(`${m.requests} req`)}`);
  const stats = Object.entries(rt.skillStats()).sort((a, b) => b[1].uses - a[1].uses).slice(0, 8);
  if (stats.length) console.log(`\n  Top skills: ${stats.map(([n, s]) => `${n} (${s.uses})`).join(', ')}`);
  console.log();
}

async function cmdUpdate(args: ParsedArgs): Promise<void> {
  let latest: string | undefined;
  try {
    const res = await fetch('https://api.github.com/repos/burkiuze/KronosAgent/releases/latest', { signal: AbortSignal.timeout(8000) });
    latest = ((await res.json()) as { tag_name?: string }).tag_name?.replace(/^v/, '');
  } catch {
    /* offline — a git checkout can still pull */
  }
  if (latest && latest !== KRONOS_VERSION) console.log(`Update available: ${KRONOS_VERSION} → ${c.bold(latest)}`);
  // installs from scripts/install.sh (and source checkouts) are git clones: update in place
  const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
  if (!existsSync(join(repo, '.git'))) {
    console.log(latest && latest !== KRONOS_VERSION ? '  Re-run the installer or download the new desktop app.' : `${c.green(sym.ok)} You are on the latest version (${KRONOS_VERSION}).`);
    return;
  }
  if (args.flags.check) return void console.log(c.gray(`  source checkout: ${repo} — run \`kronos update\` to pull and rebuild`));
  const steps: [string, string[]][] = [
    ['git', ['pull', '--ff-only']],
    ['npm', ['install', '--no-audit', '--no-fund']],
    ['npm', ['run', 'build']],
  ];
  for (const [cmd, argv] of steps) {
    console.log(c.gray(`$ ${cmd} ${argv.join(' ')}`));
    const code = await new Promise<number>((done) => spawn(cmd, argv, { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' }).on('close', (n) => done(n ?? 1)));
    if (code !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (exit ${code})`);
  }
  console.log(`${c.green(sym.ok)} Kronos updated — restart running gateways/desktop to pick it up.`);
}
