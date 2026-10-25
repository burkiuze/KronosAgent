import { createInterface, type Interface } from 'node:readline';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import type { Agent, Kronos, PermissionDecision, PermissionMode, PermissionRequest, ClarifyRequest, Effort } from '@kronos/core';
import {
  formatCost,
  formatTokens,
  formatDuration,
  truncate,
  runShell,
  PERSONALITIES,
  catalogModels,
  modelAliases,
  listProfiles,
  KRONOS_VERSION,
  closest,
  maskSecrets,
} from '@kronos/core';
import { c, hr, logo, sym, termWidth } from './ui/ansi.js';
import { EventRenderer, renderTodos } from './ui/render.js';
import { renderMarkdown } from './ui/markdown.js';
import { exportMarkdown } from '@kronos/gateway';

interface SlashCommand {
  name: string;
  args?: string;
  help: string;
  run: (arg: string) => Promise<void> | void;
}

export interface ReplOptions {
  sessionId?: string;
  initialPrompt?: string;
  model?: string;
  mode?: PermissionMode;
  verbose?: boolean;
}

const MODES: PermissionMode[] = ['ask', 'auto-edit', 'yolo', 'plan'];

export class Repl {
  private rl!: Interface;
  private agent!: Agent;
  private busy = false;
  private queue: string[] = [];
  private pendingAnswer?: (answer: string) => void;
  private multiline: string[] | null = null;
  private continuation: string[] = [];
  private verbose: boolean;
  private lastCtrlC = 0;
  private shellContext: string[] = [];
  private commands: SlashCommand[] = [];
  private historyFile: string;

  constructor(private rt: Kronos, private opts: ReplOptions = {}) {
    this.verbose = Boolean(opts.verbose);
    this.historyFile = join(rt.home, 'cli_history');
    this.buildCommands();
  }

  private write = (s: string) => {
    process.stdout.write(s);
  };

  private println(s = ''): void {
    process.stdout.write(`${s}\n`);
  }

  // -------------------------------------------------------------------------
  // Session / agent
  // -------------------------------------------------------------------------

  private attach(sessionId?: string): void {
    const rt = this.rt;
    const id = sessionId && rt.sessions.get(sessionId) ? sessionId : rt.createSession({ source: 'cli', mode: this.opts.mode ?? rt.config.safety.mode, model: this.opts.model ? rt.providers.resolve(this.opts.model).ref : '' }).id;
    this.agent = rt.agent(id, {
      surface: 'cli',
      onPermission: (req) => this.askPermission(req),
      onClarify: (req) => this.askClarify(req),
    });
    if (this.opts.mode && !sessionId) this.agent.setMode(this.opts.mode, false);
  }

  private ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.pendingAnswer = resolve;
      this.rl.setPrompt(question);
      this.rl.prompt();
    });
  }

  private async askPermission(req: PermissionRequest): Promise<PermissionDecision> {
    const lines = [
      '',
      `${c.yellow(`${sym.warn} Permission needed`)}${req.dangerous ? c.red(c.bold(' — DANGEROUS')) : ''}`,
      `  ${c.bold(req.summary)}`,
      `  ${c.gray(req.reason)}`,
    ];
    if (req.toolName === 'exit_plan_mode') lines.push('', renderMarkdown(String(req.input.plan ?? '')));
    else if (req.toolName === 'shell') lines.push(`  ${c.amber(`$ ${String(req.input.command ?? '')}`)}`);
    else if (this.verbose) lines.push(c.gray(truncate(JSON.stringify(req.input, null, 2), 1200)));
    this.println(lines.join('\n'));
    for (;;) {
      const a = (await this.ask(`  ${c.bold('[y]')}es · ${c.bold('[s]')}ession · ${c.bold('[A]')}lways · ${c.bold('[n]')}o ${c.gray('(or type feedback)')} ${sym.prompt} `)).trim();
      if (/^(y|yes|e|evet)$/i.test(a) || a === '') return { decision: 'allow' };
      if (/^s(ession)?$/i.test(a)) return { decision: 'allow_session' };
      if (a === 'A' || /^always$/i.test(a)) return { decision: 'allow_always' };
      if (/^(n|no|h|hayır)$/i.test(a)) return { decision: 'deny' };
      return { decision: 'deny', feedback: a };
    }
  }

  private async askClarify(req: ClarifyRequest): Promise<string> {
    this.println(`\n${c.cyan('?')} ${c.bold(req.question)}`);
    (req.options ?? []).forEach((o, i) => this.println(`  ${c.gold(String(i + 1))}. ${o}`));
    const a = (await this.ask(`  ${sym.prompt} `)).trim();
    const n = Number(a);
    if (req.options && Number.isInteger(n) && n >= 1 && n <= req.options.length) return req.options[n - 1] as string;
    return a;
  }

  // -------------------------------------------------------------------------
  // Banner & prompt
  // -------------------------------------------------------------------------

  private banner(): void {
    const rt = this.rt;
    const model = rt.providers.resolve(this.agent.session.model || undefined);
    this.println();
    this.println(logo());
    this.println(`  ${c.gray('A G E N T')}  ${c.dim(`v${KRONOS_VERSION}`)}  ${c.gray('— the agent that keeps time on your side')}`);
    this.println();
    const rows: [string, string][] = [
      ['Model', `${model.name} ${c.gray(`(${model.ref})`)}${model.provider === 'kronos' ? c.yellow('  ← demo mode: run `kronos setup` to add a key') : ''}`],
      ['Mode', this.modeLabel(this.agent.mode)],
      ['Profile', rt.profile],
      ['Workspace', this.agent.session.cwd],
      ['Skills', `${rt.skills.list().length} loaded · Tools ${rt.tools.resolve(rt.config.toolsets.enabled, rt).length}`],
    ];
    for (const [k, v] of rows) this.println(`  ${c.gray(k.padEnd(10))} ${v}`);
    this.println();
    this.println(c.gray('  /help commands · @file attach · !cmd shell · \\ newline · Ctrl+C interrupt · Ctrl+D exit'));
    this.println(hr());
  }

  private modeLabel(m: PermissionMode): string {
    switch (m) {
      case 'yolo':
        return c.red('yolo (no approvals)');
      case 'auto-edit':
        return c.yellow('auto-edit (file edits auto-approved)');
      case 'plan':
        return c.cyan('plan (read-only)');
      default:
        return c.green('ask (approve changes)');
    }
  }

  private promptText(): string {
    if (this.multiline || this.continuation.length) return c.gray('… ');
    const mode = this.agent.mode === 'ask' ? '' : c.gray(`[${this.agent.mode}] `);
    return `${mode}${c.gold(sym.prompt)} `;
  }

  private prompt(): void {
    this.rl.setPrompt(this.promptText());
    this.rl.prompt();
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.attach(this.opts.sessionId);
    const history = existsSync(this.historyFile) ? readFileSync(this.historyFile, 'utf8').split('\n').filter(Boolean).reverse().slice(0, 500) : [];
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      history,
      historySize: 1000,
      completer: (line: string) => this.complete(line),
    });
    this.banner();
    if (this.opts.sessionId) this.replayTail();
    this.rl.on('line', (line) => void this.onLine(line));
    this.rl.on('SIGINT', () => this.onSigint());
    this.rl.on('close', () => {
      this.println(c.gray('\nbye ⧗'));
      void this.rt.close().then(() => process.exit(0));
    });
    if (this.opts.initialPrompt) await this.submit(this.opts.initialPrompt);
    else this.prompt();
    await new Promise(() => undefined);
  }

  private replayTail(): void {
    const msgs = this.agent.history().filter((m) => m.role === 'user' || m.role === 'assistant').slice(-6);
    if (!msgs.length) return;
    this.println(c.gray(`  resumed "${this.agent.title}" — last messages:`));
    for (const m of msgs) {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
      if (!text.trim()) continue;
      this.println(`${m.role === 'user' ? c.gold(sym.prompt) : c.gray('⏺')} ${c.gray(truncate(text.replace(/\s+/g, ' '), termWidth() - 6))}`);
    }
    this.println(hr());
  }

  private onSigint(): void {
    if (this.pendingAnswer) {
      const r = this.pendingAnswer;
      this.pendingAnswer = undefined;
      r('n');
      return;
    }
    if (this.busy) {
      this.queue = [];
      this.agent.interrupt();
      this.println(c.yellow('\n⏹ interrupting…'));
      return;
    }
    const now = Date.now();
    if (this.multiline || this.continuation.length) {
      this.multiline = null;
      this.continuation = [];
      this.println();
      this.prompt();
      return;
    }
    if (now - this.lastCtrlC < 1500) this.rl.close();
    else {
      this.lastCtrlC = now;
      this.println(c.gray('\n(press Ctrl+C again or Ctrl+D to exit)'));
      this.prompt();
    }
  }

  private async onLine(raw: string): Promise<void> {
    if (this.pendingAnswer) {
      const r = this.pendingAnswer;
      this.pendingAnswer = undefined;
      r(raw);
      return;
    }
    // multi-line input: """ … """ blocks or trailing backslash
    if (this.multiline) {
      if (raw.trim() === '"""') {
        const text = this.multiline.join('\n');
        this.multiline = null;
        return this.submit(text);
      }
      this.multiline.push(raw);
      return this.prompt();
    }
    if (raw.trim() === '"""') {
      this.multiline = [];
      return this.prompt();
    }
    if (raw.endsWith('\\')) {
      this.continuation.push(raw.slice(0, -1));
      return this.prompt();
    }
    const text = [...this.continuation, raw].join('\n');
    this.continuation = [];
    if (this.busy) {
      if (text.trim()) {
        this.queue.push(text);
        this.println(c.gray(`  ${sym.hourglass} queued (${this.queue.length}) — runs after the current task`));
      }
      return;
    }
    await this.submit(text);
  }

  private async submit(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return this.prompt();
    try {
      appendFileSync(this.historyFile, `${t.replace(/\n/g, ' ')}\n`);
    } catch {
      /* ignore */
    }
    if (t.startsWith('!')) {
      await this.shell(t.slice(1));
      return this.prompt();
    }
    if (t.startsWith('/')) {
      const [name, ...rest] = t.slice(1).split(/\s+/);
      const cmd = this.commands.find((x) => x.name === name);
      if (cmd) {
        try {
          await cmd.run(rest.join(' ').trim());
        } catch (e) {
          this.println(c.red(`${sym.fail} ${(e as Error).message}`));
        }
        if (!this.busy) this.prompt();
        return;
      }
      const known = this.rt.commands(this.agent.session.cwd).some((x) => x.name === name);
      if (!known) {
        const all = [...this.commands.map((x) => x.name), ...this.rt.commands().map((x) => x.name)];
        const guess = closest(name ?? '', all);
        this.println(c.yellow(`Unknown command /${name}.${guess ? ` Did you mean /${guess}?` : ''} Type /help.`));
        return this.prompt();
      }
    }
    await this.runAgent(t);
  }

  private async runAgent(text: string): Promise<void> {
    this.busy = true;
    const renderer = new EventRenderer({ verbose: this.verbose, showThinking: this.rt.config.model.showThinking, write: this.write });
    const off = this.agent.events.on((e) => renderer.handle(e));
    try {
      let input = await this.rt.expandInput(text, this.agent.session.cwd);
      if (this.shellContext.length) {
        input = { ...input, text: `${this.shellContext.join('\n\n')}\n\n${input.text}` };
        this.shellContext = [];
      }
      if (input.command) this.println(c.gray(`  ${sym.info} /${input.command}`));
      for (const f of input.files ?? []) this.println(c.gray(`  📎 ${f.name}`));
      for (const i of input.images ?? []) this.println(c.gray(`  🖼  ${i.name ?? 'image'}`));
      this.println();
      await this.agent.run(input);
    } catch (e) {
      renderer.stopSpinner();
      this.println(c.red(`${sym.fail} ${(e as Error).message}`));
    } finally {
      off();
      this.busy = false;
    }
    this.println();
    const next = this.queue.shift();
    if (next) {
      this.println(`${c.gold(sym.prompt)} ${next}`);
      return this.runAgent(next);
    }
    this.prompt();
  }

  private async shell(cmd: string): Promise<void> {
    if (!cmd.trim()) return;
    const r = await runShell(cmd, { cwd: this.agent.session.cwd, timeoutMs: 300_000, onData: (s) => process.stdout.write(s) });
    if (r.exitCode !== 0) this.println(c.red(`exit ${r.exitCode}`));
    this.shellContext.push(`<user_shell_command>\n$ ${cmd}\n${truncate(r.output, 8000)}\n[exit ${r.exitCode}]\n</user_shell_command>`);
    this.println(c.gray('  (output will be shared with Kronos in your next message)'));
  }

  private complete(line: string): [string[], string] {
    if (line.startsWith('/') && !line.includes(' ')) {
      const names = [...this.commands.map((x) => `/${x.name}`), ...this.rt.commands().map((x) => `/${x.name}`)];
      const hits = names.filter((n) => n.startsWith(line));
      return [hits.length ? hits : names, line];
    }
    const at = /@([^\s]*)$/.exec(line);
    if (at) {
      const partial = at[1] ?? '';
      const dir = partial.includes('/') ? partial.slice(0, partial.lastIndexOf('/') + 1) : '';
      const base = partial.slice(dir.length);
      try {
        const entries = readdirSync(join(this.agent.session.cwd, dir), { withFileTypes: true })
          .filter((e) => e.name.startsWith(base) && !e.name.startsWith('.'))
          .map((e) => `@${dir}${e.name}${e.isDirectory() ? '/' : ''}`);
        return [entries, `@${partial}`];
      } catch {
        return [[], line];
      }
    }
    return [[], line];
  }

  // -------------------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------------------

  private buildCommands(): void {
    const rt = this.rt;
    const add = (name: string, help: string, run: SlashCommand['run'], args?: string) => this.commands.push({ name, help, run, args });

    add('help', 'Show commands', () => {
      this.println(c.bold('\nCommands'));
      for (const cmd of this.commands) this.println(`  ${c.gold(`/${cmd.name}`)}${cmd.args ? c.gray(` ${cmd.args}`) : ''}  ${c.gray(cmd.help)}`);
      const custom = rt.commands(this.agent.session.cwd);
      if (custom.length) {
        this.println(c.bold('\nSkills & custom commands'));
        this.println(`  ${custom.slice(0, 60).map((x) => c.gold(`/${x.name}`)).join('  ')}${custom.length > 60 ? c.gray(` … +${custom.length - 60}`) : ''}`);
      }
      this.println(c.gray('\n  !cmd runs a shell command · @path attaches a file · """ starts a multi-line block'));
    });
    add('new', 'Start a new conversation', () => {
      this.attach();
      this.println(c.green(`${sym.ok} new conversation`));
    });
    add('clear', 'Clear the screen and start fresh', () => {
      process.stdout.write('\x1b[2J\x1b[H');
      this.attach();
      this.banner();
    });
    add('model', 'Show or switch the model (e.g. /model sonnet, /model openai:gpt-5.5)', (arg) => {
      if (!arg) {
        const m = rt.providers.resolve(this.agent.session.model || undefined);
        this.println(`${c.bold(m.name)} ${c.gray(m.ref)} · context ${formatTokens(m.contextWindow)} · max out ${formatTokens(m.maxOutput)}`);
        this.println(c.gray(`  aliases: ${Object.keys(modelAliases()).join(', ')} · /models to list`));
        return;
      }
      const info = this.agent.setModel(arg);
      this.println(c.green(`${sym.ok} model → ${info.name} (${info.ref})`));
    }, '[ref]');
    add('models', 'List models for configured providers', () => {
      const configured = new Set(rt.providers.statuses().filter((p) => p.configured).map((p) => p.id));
      for (const m of catalogModels().filter((x) => configured.has(x.provider))) {
        this.println(`  ${c.gold(m.ref.padEnd(42))} ${m.name}${m.pricing ? c.gray(` $${m.pricing.input}/$${m.pricing.output} per Mtok`) : ''}`);
      }
      const missing = rt.providers.statuses().filter((p) => !p.configured && !p.local).map((p) => p.label);
      this.println(c.gray(`\n  not configured: ${missing.join(', ')}`));
    });
    add('mode', `Permission mode: ${MODES.join(' | ')}`, (arg) => {
      if (!MODES.includes(arg as PermissionMode)) {
        this.println(`current: ${this.modeLabel(this.agent.mode)}  ${c.gray(`(use /mode ${MODES.join('|')})`)}`);
        return;
      }
      this.agent.setMode(arg as PermissionMode);
      this.println(`${sym.ok} ${this.modeLabel(arg as PermissionMode)}`);
    }, '[mode]');
    add('plan', 'Enter plan mode (read-only, then approve a plan)', () => {
      this.agent.setMode('plan');
      this.println(this.modeLabel('plan'));
    });
    add('yolo', 'Toggle yolo mode (no approvals)', () => {
      this.agent.setMode(this.agent.mode === 'yolo' ? 'ask' : 'yolo');
      this.println(this.modeLabel(this.agent.mode));
    });
    add('effort', 'Reasoning effort: low | medium | high | xhigh | max', (arg) => {
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(arg)) {
        this.println(`effort: ${rt.config.model.effort}`);
        return;
      }
      rt.updateConfig({ model: { effort: arg as Effort } });
      this.println(`${sym.ok} effort → ${arg}`);
    }, '[level]');
    add('think', 'Toggle showing thinking', () => {
      rt.updateConfig({ model: { showThinking: !rt.config.model.showThinking } });
      this.println(`thinking display ${rt.config.model.showThinking ? 'on' : 'off'}`);
    });
    add('verbose', 'Toggle technical tool output', () => {
      this.verbose = !this.verbose;
      this.println(`verbose ${this.verbose ? 'on' : 'off'}`);
    });
    add('tools', 'List available tools', () => {
      for (const t of rt.tools.status(rt, rt.config.toolsets.enabled)) {
        const state = !t.enabled ? c.gray('off') : t.available ? c.green('on') : c.yellow('needs setup');
        this.println(`  ${c.bold(t.label.padEnd(16))} ${state.padEnd(12)} ${c.gray(t.tools.map((x) => x.name).join(', '))}`);
      }
    });
    add('skills', 'List skills', (arg) => {
      const list = arg ? rt.skills.search(arg, 30) : rt.skills.list();
      let cat = '';
      for (const s of list) {
        if (s.category !== cat) {
          cat = s.category;
          this.println(c.bold(`\n  ${cat}`));
        }
        this.println(`    ${c.gold(s.name.padEnd(26))} ${c.gray(truncate(s.description, termWidth() - 34))}`);
      }
      this.println(c.gray('\n  use /<skill> to invoke one'));
    }, '[query]');
    add('memory', 'Show memory and user profile', () => {
      this.println(c.gray(rt.memory.snapshot()));
    });
    add('remember', 'Save a note to memory', (arg) => {
      const r = rt.memory.add('memory', arg);
      this.println(r.ok ? c.green(`${sym.ok} ${r.message}`) : c.red(r.message));
    }, '<text>');
    add('forget', 'Remove a memory entry (substring)', (arg) => {
      const r = rt.memory.remove('memory', arg);
      this.println(r.ok ? c.green(`${sym.ok} ${r.message}`) : c.red(r.message));
    }, '<text>');
    add('compact', 'Compress the conversation (optional focus)', async (arg) => {
      const r = await this.agent.compact(undefined, undefined, arg || undefined);
      this.println(c.green(`${sym.ok} ~${formatTokens(r.before)} → ~${formatTokens(r.after)} tokens`));
    }, '[focus]');
    add('context', 'Show context window usage', () => {
      const u = this.agent.contextUsage();
      const width = 40;
      const filled = Math.round((u.percent / 100) * width);
      this.println(`  ${c.gold('█'.repeat(filled))}${c.gray('░'.repeat(Math.max(0, width - filled)))} ${u.percent}%  ${formatTokens(u.tokens)} / ${formatTokens(u.window)}`);
    });
    add('undo', 'Undo the last turn (restores edited files)', () => {
      const u = this.agent.undo();
      if (!u) return this.println(c.gray('nothing to undo'));
      this.println(c.green(`${sym.ok} undid "${truncate(u.text, 60)}"${u.restoredFiles.length ? ` · restored ${u.restoredFiles.length} file(s)` : ''}`));
    });
    add('retry', 'Redo the last turn', async () => {
      const u = this.agent.undo();
      if (!u) return this.println(c.gray('nothing to retry'));
      await this.runAgent(u.text);
    });
    add('cost', 'Token usage and cost for this session', () => {
      const s = rt.sessions.get(this.agent.id);
      const u = s?.usage;
      if (!u) return;
      this.println(`  input ${formatTokens(u.inputTokens)} · cached ${formatTokens(u.cacheReadTokens)} · written ${formatTokens(u.cacheWriteTokens)} · output ${formatTokens(u.outputTokens)} · ${c.bold(formatCost(u.costUsd ?? 0))}`);
    });
    add('todos', 'Show the task list', () => {
      this.println(this.agent.todos.length ? renderTodos(this.agent.todos) : c.gray('no todos'));
    });
    add('sessions', 'List recent sessions', () => {
      for (const s of rt.sessions.list({ limit: 20 })) {
        this.println(`  ${c.gray(s.id)} ${s.pinned ? c.gold('★ ') : ''}${truncate(s.title, 50).padEnd(50)} ${c.gray(`${s.source} · ${new Date(s.updatedAt).toLocaleString()}`)}`);
      }
      this.println(c.gray('  /resume <id> to continue one'));
    });
    add('resume', 'Resume a session', (arg) => {
      const id = arg || rt.sessions.list({ limit: 2, source: 'cli' }).find((s) => s.id !== this.agent.id)?.id;
      if (!id || !rt.sessions.get(id)) return this.println(c.red('session not found'));
      this.attach(id);
      this.println(c.green(`${sym.ok} resumed "${this.agent.title}"`));
      this.replayTail();
    }, '[id]');
    add('title', 'Rename this session', (arg) => {
      this.agent.rename(arg);
      this.println(c.green(`${sym.ok} renamed`));
    }, '<title>');
    add('search', 'Search past conversations', (arg) => {
      for (const h of rt.sessions.search(arg, { limit: 12 })) this.println(`  ${c.gold(truncate(h.title, 40))} ${c.gray(h.sessionId)}\n    ${c.gray(h.snippet)}`);
    }, '<query>');
    add('export', 'Export this session to markdown', (arg) => {
      const s = rt.sessions.get(this.agent.id);
      if (!s) return;
      const file = arg || join(this.agent.session.cwd, `kronos-${s.id}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, exportMarkdown(s, rt.sessions.messages(s.id)));
      this.println(c.green(`${sym.ok} exported to ${file}`));
    }, '[file]');
    add('personality', `Set personality: ${Object.keys(PERSONALITIES).join(', ')}`, (arg) => {
      if (!PERSONALITIES[arg]) return this.println(`current: ${rt.config.agent.personality} · options: ${Object.keys(PERSONALITIES).join(', ')}`);
      rt.updateConfig({ agent: { personality: arg } });
      this.agent.refreshContext();
      this.println(c.green(`${sym.ok} personality → ${arg} (applies from the next message)`));
    }, '[name]');
    add('profile', 'Show profiles (switch with `kronos -p <name>`)', () => {
      this.println(listProfiles(rt.home).map((p) => (p === rt.profile ? c.gold(`● ${p}`) : `  ${p}`)).join('\n'));
    });
    add('cron', 'List automations', () => {
      const jobs = rt.cron.list();
      if (!jobs.length) return this.println(c.gray('no automations — ask Kronos to schedule one'));
      for (const j of jobs) this.println(`  ${j.enabled ? c.green('●') : c.gray('○')} ${c.bold(j.name)} ${c.gray(`${j.description} · next ${j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '—'} · ${j.id}`)}`);
    });
    add('agents', 'List subagent types', () => {
      for (const a of rt.agentDefinitions(this.agent.session.cwd)) this.println(`  ${c.gold(a.name.padEnd(12))} ${c.gray(a.description)}`);
    });
    add('cwd', 'Show or change the working directory', (arg) => {
      if (!arg) return this.println(this.agent.session.cwd);
      const p = arg.startsWith('/') ? arg : join(this.agent.session.cwd, arg);
      if (!existsSync(p)) return this.println(c.red('no such directory'));
      rt.sessions.update(this.agent.id, { cwd: p });
      this.agent.session.cwd = p;
      this.agent.refreshContext();
      this.println(c.green(`${sym.ok} cwd → ${p}`));
    }, '[path]');
    add('init', 'Analyze this project and write a KRONOS.md guide', async () => {
      await this.runAgent(
        'Analyze this repository (structure, languages, build/test/lint commands, conventions, architecture) and create a concise KRONOS.md at the project root that will help future agent sessions work here effectively. Include: project overview, key commands, code style conventions, architecture map, and gotchas. If a KRONOS.md, AGENTS.md or CLAUDE.md exists, improve it instead of duplicating.',
      );
    });
    add('review', 'Review uncommitted changes', async () => {
      await this.runAgent('Review the uncommitted changes in this repository (git diff, including untracked files). Delegate to a reviewer subagent if the diff is large. Report real bugs with file:line, severity and a concrete fix; skip style nits.');
    });
    add('config', 'Show configuration (secrets masked)', (arg) => {
      const cfg = maskSecrets(rt.rawConfig) as unknown as Record<string, unknown>;
      this.println(JSON.stringify(arg ? cfg[arg] : cfg, null, 2));
    }, '[section]');
    add('doctor', 'Diagnose the installation', async () => {
      for (const r of await rt.doctor()) this.println(`  ${r.ok ? c.green(sym.ok) : c.yellow(sym.warn)} ${r.check.padEnd(22)} ${c.gray(r.detail)}`);
    });
    add('usage', 'Usage over the last 30 days', () => {
      const rows = rt.sessions.usageSummary({ since: Date.now() - 30 * 86400_000, groupBy: 'model' });
      for (const r of rows) this.println(`  ${r.key.padEnd(40)} ${formatTokens(r.inputTokens + r.cacheReadTokens).padStart(8)} in ${formatTokens(r.outputTokens).padStart(8)} out ${formatCost(r.costUsd).padStart(9)}  ${c.gray(`${r.requests} req`)}`);
    });
    add('version', 'Show version', () => this.println(`Kronos Agent v${KRONOS_VERSION}`));
    add('exit', 'Exit', () => this.rl.close());
    add('quit', 'Exit', () => this.rl.close());
    void formatDuration;
    void basename;
  }
}
