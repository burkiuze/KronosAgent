import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition } from './types.js';
import { explainExit, which } from '../util/process.js';
import { resolvePath } from '../config/paths.js';
import { truncate } from '../util/text.js';
import { formatDuration } from '../util/misc.js';

function formatRun(r: { output: string; exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean; durationMs: number }, timeoutSec: number): string {
  const out = r.output.replace(/\s+$/, '');
  const notes: string[] = [];
  if (r.timedOut) notes.push(`timed out after ${timeoutSec}s — for long-running work use background: true`);
  if (r.aborted) notes.push('interrupted by the user');
  const why = explainExit(r.exitCode, r.signal);
  if (why) notes.push(why);
  const status = `[exit ${r.exitCode ?? r.signal ?? '?'} · ${formatDuration(r.durationMs)}${notes.length ? ` · ${notes.join('; ')}` : ''}]`;
  return `${out || '(no output)'}\n${status}`;
}

export const shellTool: ToolDefinition<{ command: string; timeout?: number; cwd?: string; background?: boolean; description?: string }> = {
  name: 'shell',
  toolset: 'shell',
  risk: 'execute',
  description:
    'Run a shell command (bash on Linux/macOS, cmd/PowerShell on Windows) in the configured terminal backend (local, Docker sandbox or SSH). ' +
    'Returns combined stdout/stderr and the exit status. Commands run non-interactively: pass flags like -y / --no-pager, never open editors. ' +
    'Use background: true for servers/watchers, then the `process` tool to read output or stop them. ' +
    'Prefer dedicated tools for reading/searching/editing files.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute.' },
      description: { type: 'string', description: 'Short (5-10 words) description of what the command does, shown to the user.' },
      timeout: { type: 'integer', description: 'Timeout in seconds (default from config, max 1800).', minimum: 1, maximum: 1800 },
      cwd: { type: 'string', description: 'Working directory (default: the session working directory).' },
      background: { type: 'boolean', description: 'Start the command in the background and return immediately.' },
    },
    required: ['command'],
  },
  summarize: (i) => i.description || `$ ${truncate(i.command, 80)}`,
  async execute(input, ctx) {
    const cwd = input.cwd ? resolvePath(input.cwd, ctx.cwd) : ctx.cwd;
    const rt = ctx.runtime;
    if (input.background) {
      if (rt.config.terminal.backend !== 'local') return { content: 'Background processes are only supported on the local backend; run with a timeout instead.', isError: true };
      const p = rt.processes.start(input.command, cwd, ctx.sessionId, rt.config.terminal.shell);
      await new Promise((r) => setTimeout(r, 1500));
      const early = rt.processes.output(p.id, { tail: 40 });
      const status = rt.processes.list().find((x) => x.id === p.id);
      return {
        content: `Started background process ${p.id} (pid ${p.pid}).${status && !status.running ? ` It already exited with code ${status.exitCode}.` : ''}\nInitial output:\n${early || '(none yet)'}\nUse process(action:"output", id:"${p.id}") to read more, process(action:"kill") to stop.`,
        meta: { processId: p.id },
      };
    }
    const timeoutSec = Math.min(1800, input.timeout ?? rt.config.terminal.timeoutSec);
    let lastProgress = 0;
    let buffered = '';
    const r = await rt.backend.exec(input.command, {
      cwd,
      timeoutMs: timeoutSec * 1000,
      signal: ctx.signal,
      onData: (chunk) => {
        buffered += chunk;
        const now = Date.now();
        if (now - lastProgress > 400) {
          lastProgress = now;
          ctx.progress(buffered.slice(-2000));
        }
      },
    });
    return {
      content: formatRun(r, timeoutSec),
      isError: r.exitCode !== 0,
      meta: { exitCode: r.exitCode, durationMs: r.durationMs, command: input.command },
    };
  },
};

export const processTool: ToolDefinition<{ action: 'list' | 'output' | 'kill' | 'write'; id?: string; input?: string; tail?: number }> = {
  name: 'process',
  toolset: 'shell',
  risk: (i) => (i.action === 'list' || i.action === 'output' ? 'read' : 'execute'),
  parallelSafe: true,
  description: 'Manage background processes started with shell(background:true): list, output (new output since last read), kill, write (send stdin).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'output', 'kill', 'write'] },
      id: { type: 'string', description: 'Process id (p_…).' },
      input: { type: 'string', description: 'Text to send to stdin (action write).' },
      tail: { type: 'integer', description: 'Only return the last N lines.' },
    },
    required: ['action'],
  },
  summarize: (i) => `Process ${i.action}${i.id ? ` ${i.id}` : ''}`,
  async execute(input, ctx) {
    const pm = ctx.runtime.processes;
    switch (input.action) {
      case 'list': {
        const list = pm.list();
        if (!list.length) return { content: 'No background processes.' };
        return {
          content: list
            .map((p) => `${p.id}  pid=${p.pid}  ${p.running ? 'running' : `exited(${p.exitCode})`}  ${formatDuration(Date.now() - p.startedAt)}  ${truncate(p.command, 80)}`)
            .join('\n'),
        };
      }
      case 'output':
        if (!input.id) return { content: 'id is required', isError: true };
        return { content: pm.output(input.id, { tail: input.tail }) || '(no new output)' };
      case 'kill':
        if (!input.id) return { content: 'id is required', isError: true };
        return { content: pm.kill(input.id) ? `Stopped ${input.id}` : `No process ${input.id}` };
      case 'write':
        if (!input.id) return { content: 'id is required', isError: true };
        pm.write(input.id, input.input ?? '');
        return { content: 'sent' };
      default:
        return { content: 'unknown action', isError: true };
    }
  },
};

const RUNNERS: Record<string, { file: string; bins: string[]; args: (f: string) => string[] }> = {
  python: { file: 'main.py', bins: ['python3', 'python'], args: (f) => [f] },
  javascript: { file: 'main.mjs', bins: ['node'], args: (f) => [f] },
  typescript: { file: 'main.ts', bins: ['node'], args: (f) => ['--experimental-strip-types', '--no-warnings', f] },
  bash: { file: 'main.sh', bins: ['bash', 'sh'], args: (f) => [f] },
};

export const executeCodeTool: ToolDefinition<{ language: 'python' | 'javascript' | 'typescript' | 'bash'; code: string; timeout?: number }> = {
  name: 'execute_code',
  toolset: 'code',
  risk: 'execute',
  description:
    'Execute a self-contained Python, JavaScript (Node ESM), TypeScript or Bash script and return its output. Good for calculations, data processing, ' +
    'parsing files and chaining many steps in one call. The working directory is the session workspace.',
  parameters: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'javascript', 'typescript', 'bash'] },
      code: { type: 'string' },
      timeout: { type: 'integer', minimum: 1, maximum: 1800, description: 'Seconds (default 120).' },
    },
    required: ['language', 'code'],
  },
  summarize: (i) => `Run ${i.language} (${(i.code ?? '').split('\n').length} lines)`,
  async execute(input, ctx) {
    const runner = RUNNERS[input.language];
    if (!runner) return { content: `unsupported language ${input.language}`, isError: true };
    let bin: string | null = null;
    for (const b of runner.bins) if ((bin = await which(b))) break;
    if (!bin && ctx.runtime.config.terminal.backend === 'local') return { content: `${input.language} runtime not found (${runner.bins.join('/')})`, isError: true };
    const dir = mkdtempSync(join(tmpdir(), 'kronos-code-'));
    const file = join(dir, runner.file);
    writeFileSync(file, input.code);
    try {
      const timeoutSec = input.timeout ?? 120;
      const cmd = [runner.bins[0], ...runner.args(file)].map((a) => (/\s/.test(a as string) ? JSON.stringify(a) : a)).join(' ');
      const r =
        ctx.runtime.config.terminal.backend === 'local'
          ? await ctx.runtime.backend.exec([bin, ...runner.args(file)].map((a) => JSON.stringify(a)).join(' '), { cwd: ctx.cwd, timeoutMs: timeoutSec * 1000, signal: ctx.signal })
          : await ctx.runtime.backend.exec(`cat > /tmp/${runner.file} <<'KRONOS_EOF'\n${input.code}\nKRONOS_EOF\n${cmd.replace(file, `/tmp/${runner.file}`)}`, { cwd: ctx.cwd, timeoutMs: timeoutSec * 1000, signal: ctx.signal });
      return { content: formatRun(r, timeoutSec), isError: r.exitCode !== 0, meta: { exitCode: r.exitCode, durationMs: r.durationMs } };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

export const shellTools = [shellTool, processTool, executeCodeTool] as ToolDefinition[];
