import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition } from './types.js';
import { explainExit, which } from '../util/process.js';
import { resolvePath } from '../config/paths.js';
import { truncate, truncateMiddle } from '../util/text.js';

/** The last part of long output (what a still-running command printed most recently). */
function truncateTail(text: string, max = 6000): string {
  return text.length > max ? `…${text.slice(-max)}` : truncateMiddle(text, max).text;
}
import { formatDuration } from '../util/misc.js';
import { detectProjectChecks, failureHighlights, type ProjectCheck } from '../agent/checks.js';
import { ensureNetworkProxy, proxiedNetwork, runningNetworkProxy, wrapCommand } from '../backends/sandbox.js';

function formatRun(r: { output: string; exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean; durationMs: number; adopted?: string }, timeoutSec: number): string {
  const out = r.output.replace(/\s+$/, '');
  if (r.adopted) {
    return `${out ? `${truncateTail(out)}\n` : ''}[still running after ${timeoutSec}s — it keeps running in the background as ${r.adopted}. Use process(action:"output", id:"${r.adopted}") to follow it, process(action:"kill", id:"${r.adopted}") to stop it.]`;
  }
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
    'A command still running at its timeout is not killed: it continues in the background and you get its process id. ' +
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
      const p = rt.processes.start(input.command, cwd, ctx.sessionId, rt.config.terminal.shell, rt.config.terminal.sandbox);
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
    // `git push`/`fetch` on a GitHub checkout authenticate with the connected account (never stored)
    const env = rt.backend.name === 'local' && /\bgit\b/.test(input.command) ? await rt.github.shellEnv(cwd) : {};
    const r = await rt.backend.exec(input.command, {
      cwd,
      env,
      timeoutMs: timeoutSec * 1000,
      signal: ctx.signal,
      // past its timeout a command is not killed but moves to the background (like Codex's exec sessions)
      adopt: (child, soFar) => rt.processes.adopt(child, input.command, cwd, soFar, ctx.sessionId).id,
      onData: (chunk) => {
        // only the tail is ever shown as progress: keep memory flat for chatty commands
        buffered = (buffered + chunk).slice(-4000);
        const now = Date.now();
        if (now - lastProgress > 400) {
          lastProgress = now;
          ctx.progress(buffered.slice(-2000));
        }
      },
    });
    return {
      content: formatRun(r, timeoutSec),
      isError: !r.adopted && r.exitCode !== 0,
      meta: { exitCode: r.exitCode, durationMs: r.durationMs, command: input.command, ...(r.adopted ? { processId: r.adopted } : {}) },
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

export const executeCodeTool: ToolDefinition<{ language: 'python' | 'javascript' | 'typescript' | 'bash'; code: string; timeout?: number; persistent?: boolean; reset?: boolean }> = {
  name: 'execute_code',
  toolset: 'code',
  risk: 'execute',
  description:
    'Execute a self-contained Python, JavaScript (Node ESM), TypeScript or Bash script and return its output. Good for calculations, data processing, ' +
    'parsing files and chaining many steps in one call. The working directory is the session workspace. ' +
    'persistent: true (Python/JavaScript) runs the code in this conversation\'s kernel, so variables, imports and loaded data stay for the next call ' +
    '(like a notebook; the value of a final expression is shown). reset: true starts a fresh kernel.',
  parameters: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'javascript', 'typescript', 'bash'] },
      code: { type: 'string' },
      timeout: { type: 'integer', minimum: 1, maximum: 1800, description: 'Seconds (default 120).' },
      persistent: { type: 'boolean', description: 'Keep state between calls (python, javascript).' },
      reset: { type: 'boolean', description: 'With persistent: discard the kernel state first.' },
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
    if (input.persistent && (input.language === 'python' || input.language === 'javascript') && bin && ctx.runtime.config.terminal.backend === 'local') {
      const timeoutSec = input.timeout ?? 120;
      const sandbox = ctx.runtime.config.terminal.sandbox;
      const sandboxed = sandbox && sandbox.mode !== 'off';
      if (sandboxed && proxiedNetwork(sandbox)) await ensureNetworkProxy(sandbox);
      const r = await ctx.runtime.kernels.run({
        sessionId: ctx.sessionId,
        language: input.language,
        bin: input.language === 'javascript' ? process.execPath : bin,
        cwd: ctx.cwd,
        code: input.code,
        timeoutMs: timeoutSec * 1000,
        reset: input.reset,
        signal: ctx.signal,
        wrap: sandboxed
          ? (file, args) => {
              const w = wrapCommand(file, args, ctx.cwd, sandbox, runningNetworkProxy()?.port);
              return 'error' in w && sandbox.fallback === 'unsandboxed' ? { file, args } : w;
            }
          : undefined,
      });
      const head = `[${input.language} kernel · cell ${r.count}${r.fresh ? ' · new kernel (no earlier state)' : ''}]`;
      const lost = r.status === 'timeout' || r.status === 'interrupted' || r.status === 'died';
      const body = [
        r.output.replace(/\s+$/, ''),
        r.value ? `Out: ${r.value}` : '',
        r.error ? r.error.replace(/\s+$/, '') : '',
        lost ? `[${r.status === 'timeout' ? `timed out after ${timeoutSec}s` : r.status === 'interrupted' ? 'interrupted' : 'the kernel exited'} — its state is gone; the next persistent call starts a fresh kernel]` : '',
      ].filter(Boolean);
      return { content: `${head}\n${truncate(body.join('\n') || '(no output)', 60_000)}`, isError: r.status !== 'ok', meta: { kernelCell: r.count, status: r.status } };
    }
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

/**
 * Verification as a tool rather than a request: runs the project's own checks (or a given
 * command) and returns a verdict with the failing lines first. Asking a model to "verify" barely
 * changes what it does; a dedicated tool that makes checking cheap and the result explicit does.
 */
export const verifyTool: ToolDefinition<{ checks?: string[]; command?: string; timeout?: number }> = {
  name: 'verify',
  toolset: 'shell',
  risk: 'execute',
  description:
    "Check that the work is actually correct by running the project's own checks — detected automatically (typecheck, lint, test, build from " +
    'package.json, pyproject, Cargo, go.mod, Makefile, …) — or a specific command. Returns PASS/FAIL per check with the failing lines first. ' +
    'Run it after changing code and before reporting success; fix and re-run until it passes, or report exactly what still fails. ' +
    'checks: subset to run, e.g. ["test"] (default: all detected). command: run this instead (e.g. a single test file).',
  parameters: {
    type: 'object',
    properties: {
      checks: { type: 'array', items: { type: 'string' }, description: 'Which detected checks to run (typecheck, lint, test, build). Default: all.' },
      command: { type: 'string', description: 'A specific verification command, e.g. "npx vitest run src/cart.test.ts".' },
      timeout: { type: 'integer', minimum: 10, maximum: 1800, description: 'Timeout per check in seconds (default 600).' },
    },
  },
  summarize: (i) => (i.command ? `Verify: ${truncate(i.command, 70)}` : `Verify ${(i.checks ?? ['all checks']).join(', ')}`),
  async execute(input, ctx) {
    let plan: ProjectCheck[];
    if (input.command) plan = [{ name: 'check', command: input.command, source: 'given' }];
    else {
      const detected = detectProjectChecks(ctx.cwd);
      plan = input.checks?.length ? detected.filter((c) => input.checks!.includes(c.name)) : detected;
      if (!detected.length)
        return {
          content: 'No project checks were detected here (no package.json scripts, pyproject, Cargo.toml, go.mod or Makefile targets). Pass `command` with the command that proves the change works.',
          isError: true,
        };
      if (!plan.length) return { content: `None of ${input.checks?.join(', ')} exist. Detected: ${detected.map((c) => c.name).join(', ')}.`, isError: true };
    }
    const timeoutSec = Math.min(1800, input.timeout ?? Math.max(600, ctx.runtime.config.terminal.timeoutSec));
    const results: { check: ProjectCheck; ok: boolean; exitCode: number | null; durationMs: number; output: string; timedOut: boolean }[] = [];
    for (const check of plan) {
      if (ctx.signal.aborted) break;
      ctx.progress(`${check.name}: ${check.command}`);
      const r = await ctx.runtime.backend.exec(check.command, { cwd: ctx.cwd, timeoutMs: timeoutSec * 1000, signal: ctx.signal });
      results.push({ check, ok: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output, timedOut: r.timedOut });
    }
    const passed = results.filter((r) => r.ok).length;
    const ok = results.length === plan.length && passed === results.length;
    ctx.agent.noteVerification(ok);
    const lines = [`VERIFY: ${ok ? 'PASS' : 'FAIL'} (${passed}/${plan.length} checks passed)`];
    for (const r of results) {
      lines.push(`${r.ok ? '✓' : '✗'} ${r.check.name.padEnd(9)} ${r.check.command}  (${formatDuration(r.durationMs)}${r.ok ? '' : r.timedOut ? ', timed out' : `, exit ${r.exitCode}`})`);
    }
    for (const r of results.filter((x) => !x.ok)) {
      const highlights = failureHighlights(r.output);
      lines.push('', `--- ${r.check.name}: ${highlights.length ? 'failing lines' : 'output (tail)'} ---`);
      lines.push(highlights.length ? highlights.join('\n') : r.output.trimEnd().split('\n').slice(-40).join('\n'));
      if (highlights.length) lines.push(`--- ${r.check.name}: output (tail) ---`, r.output.trimEnd().split('\n').slice(-25).join('\n'));
    }
    return {
      content: lines.join('\n'),
      isError: !ok,
      meta: { verdict: ok ? 'pass' : 'fail', checks: results.map((r) => ({ name: r.check.name, command: r.check.command, ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs })) },
    };
  },
};

export const shellTools = [shellTool, processTool, executeCodeTool, verifyTool] as ToolDefinition[];
