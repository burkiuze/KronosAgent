import type { AgentEvent, Todo, Usage } from '@kronos/core';
import { formatCost, formatDuration, formatTokens, truncate } from '@kronos/core';
import { c, sym, termWidth } from './ansi.js';
import { MarkdownStream, renderDiff } from './markdown.js';

export class Spinner {
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private text = '';
  private readonly frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  active = false;
  constructor(private stream: NodeJS.WriteStream = process.stderr) {}

  start(text: string): void {
    if (!this.stream.isTTY) return;
    this.text = text;
    if (this.active) return;
    this.active = true;
    this.timer = setInterval(() => this.draw(), 90);
    this.draw();
  }

  update(text: string): void {
    this.text = text;
  }

  private draw(): void {
    const f = this.frames[this.frame++ % this.frames.length];
    this.stream.write(`\r\x1b[2K${c.gold(f ?? '')} ${c.dim(truncate(this.text, termWidth() - 6))}`);
  }

  stop(): void {
    if (!this.active) return;
    clearInterval(this.timer);
    this.active = false;
    this.stream.write('\r\x1b[2K');
  }
}

export interface RenderOptions {
  verbose: boolean;
  showThinking: boolean;
  write: (s: string) => void;
}

/** Turns the agent event stream into a readable terminal transcript. */
export class EventRenderer {
  private md: MarkdownStream;
  private spinner = new Spinner();
  private thinking = false;
  private thinkingChars = 0;
  private textOpen = false;
  private calls = new Map<string, { name: string; summary: string }>();
  private started = Date.now();
  private lastUsage?: { total: Usage; context: number; window: number };

  constructor(private opts: RenderOptions) {
    this.md = new MarkdownStream((s) => this.opts.write(s));
  }

  private out(s: string): void {
    this.spinner.stop();
    this.opts.write(s);
  }

  private endThinking(): void {
    if (this.thinking) {
      this.thinking = false;
      this.out('\n');
    }
  }

  private endText(): void {
    if (this.textOpen) {
      this.spinner.stop();
      this.md.flush();
      this.textOpen = false;
    }
  }

  stopSpinner(): void {
    this.spinner.stop();
  }

  handle(e: AgentEvent): void {
    switch (e.type) {
      case 'run_start':
        this.started = Date.now();
        this.spinner.start('Thinking…');
        break;
      case 'turn_start':
        if (!this.textOpen) this.spinner.start('Thinking…');
        break;
      case 'thinking_delta':
        if (!this.opts.showThinking) {
          this.spinner.update('Thinking…');
          break;
        }
        if (!this.thinking) {
          this.endText();
          this.out(`${c.gray(`${sym.think} `)}`);
          this.thinking = true;
          this.thinkingChars = 0;
        }
        if (this.thinkingChars < 600 || this.opts.verbose) {
          this.out(c.dim(c.italic(e.text.replace(/\n+/g, ' '))));
          this.thinkingChars += e.text.length;
          if (this.thinkingChars >= 600 && !this.opts.verbose) this.out(c.dim('…'));
        }
        break;
      case 'text_delta':
        if (this.thinking) {
          this.thinking = false;
          this.out('\n\n');
        }
        if (!this.textOpen) {
          this.spinner.stop();
          this.textOpen = true;
        }
        this.spinner.stop();
        this.md.push(e.text);
        break;
      case 'tool_call_start':
        this.endThinking();
        this.endText();
        this.spinner.start(`Preparing ${e.name}…`);
        break;
      case 'tool_call': {
        this.endThinking();
        this.endText();
        this.calls.set(e.id, { name: e.name, summary: e.summary });
        const args = this.opts.verbose ? `\n${c.gray(truncate(JSON.stringify(e.input, null, 2), 1500).replace(/^/gm, '     '))}` : '';
        this.out(`${c.gold(sym.tool)} ${c.bold(e.summary)}${args}\n`);
        this.spinner.start(`${e.summary}…`);
        break;
      }
      case 'tool_progress':
        this.spinner.update(e.text.trim().split('\n').pop() ?? '');
        break;
      case 'tool_result': {
        this.spinner.stop();
        const lines = e.content.split('\n');
        let body: string;
        if (e.isError) body = c.red(truncate(lines.slice(0, this.opts.verbose ? 40 : 4).join('\n'), this.opts.verbose ? 4000 : 400));
        else if (e.meta?.diff) {
          const d = e.meta.diff as string;
          body = `${c.gray(lines[0] ?? '')}\n${renderDiff(d, this.opts.verbose ? 200 : 24)}`;
        } else if (this.opts.verbose) body = c.gray(truncate(e.content, 3000));
        else {
          const first = lines.find((l) => l.trim()) ?? '(no output)';
          body = c.gray(`${truncate(first, termWidth() - 12)}${lines.length > 1 ? c.dim(` (+${lines.length - 1} lines)`) : ''}`);
        }
        const dur = e.durationMs > 1500 ? c.dim(` · ${formatDuration(e.durationMs)}`) : '';
        this.out(`  ${c.gray(sym.result)} ${body.replace(/\n/g, '\n    ')}${dur}\n`);
        if (e.images?.length) this.out(`    ${c.cyan(`🖼  ${e.images.length} image(s)`)}${e.meta?.path ? c.gray(` → ${String(e.meta.path)}`) : ''}\n`);
        this.spinner.start('Thinking…');
        break;
      }
      case 'todos':
        this.endText();
        this.out(`${renderTodos(e.todos)}\n`);
        break;
      case 'subagent':
        if (e.status === 'start') this.out(`  ${c.cyan('↳')} ${c.bold(e.label)} ${c.gray(truncate(e.detail ?? '', 80))}\n`);
        else if (e.status === 'running') this.spinner.update(`[${e.label}] ${e.detail ?? ''}`);
        else this.out(`  ${e.status === 'done' ? c.green(sym.ok) : c.red(sym.fail)} ${c.bold(e.label)}${e.detail ? c.gray(` ${truncate(e.detail, 80)}`) : ''}\n`);
        break;
      case 'compaction':
        this.out(`${c.gray(`🗜  compacted context ~${formatTokens(e.beforeTokens)} → ~${formatTokens(e.afterTokens)} tokens`)}\n`);
        break;
      case 'notice': {
        this.endText();
        const color = e.level === 'error' ? c.red : e.level === 'warn' ? c.yellow : c.gray;
        this.out(`${color(`${e.level === 'error' ? sym.fail : e.level === 'warn' ? sym.warn : sym.info} ${e.text}`)}\n`);
        break;
      }
      case 'usage':
        this.lastUsage = { total: e.total, context: e.contextTokens, window: e.contextWindow };
        break;
      case 'run_end': {
        this.endThinking();
        this.endText();
        this.spinner.stop();
        const u = e.usage;
        const parts = [
          `${formatTokens(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)} in`,
          `${formatTokens(u.outputTokens)} out`,
          u.cacheReadTokens ? `${Math.round((u.cacheReadTokens / Math.max(1, u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)) * 100)}% cached` : '',
          u.costUsd ? formatCost(u.costUsd) : '',
          formatDuration(e.durationMs),
          this.lastUsage ? `ctx ${Math.round((this.lastUsage.context / this.lastUsage.window) * 100)}%` : '',
        ].filter(Boolean);
        const status = e.stopReason === 'end_turn' ? '' : ` · ${e.stopReason}`;
        this.out(`${c.gray(`\n  ${parts.join(' · ')}${status}`)}\n`);
        break;
      }
      default:
        break;
    }
  }
}

export function renderTodos(todos: Todo[]): string {
  const icon = (t: Todo) =>
    t.status === 'completed' ? c.green('☑') : t.status === 'in_progress' ? c.gold('◐') : t.status === 'cancelled' ? c.gray('☒') : c.gray('☐');
  const text = (t: Todo) =>
    t.status === 'completed' ? c.dim(c.gray(t.content)) : t.status === 'in_progress' ? c.bold(t.activeForm ?? t.content) : t.content;
  return todos.map((t) => `  ${icon(t)} ${text(t)}`).join('\n');
}
