import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stripAnsi } from './text.js';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string;
  shell?: string;
  onData?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  maxBuffer?: number;
  /**
   * On timeout, hand the still-running process over instead of killing it (Codex's unified exec
   * yields a session id the same way). Returns the id it is known by from then on.
   */
  adopt?: (child: ChildProcess, outputSoFar: string) => string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** interleaved output as the user would have seen it */
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** id of the background process the command became after its timeout (see RunOptions.adopt) */
  adopted?: string;
}

export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec ?? 'cmd.exe';
  if (process.env.SHELL && existsSync(process.env.SHELL)) return process.env.SHELL;
  return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

export function shellArgs(shell: string, command: string): string[] {
  if (/cmd(\.exe)?$/i.test(shell)) return ['/d', '/s', '/c', command];
  if (/powershell|pwsh/i.test(shell)) return ['-NoProfile', '-Command', command];
  return ['-c', command];
}

export function killTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

/** Run a shell command with timeout, abort, streaming and process-group cleanup. */
export function runShell(command: string, opts: RunOptions = {}): Promise<RunResult> {
  const shell = opts.shell ?? defaultShell();
  return runProcess(shell, shellArgs(shell, command), opts);
}

export function runProcess(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  const maxBuffer = opts.maxBuffer ?? 20 * 1024 * 1024;
  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, TERM: process.env.TERM ?? 'xterm-256color', KRONOS_AGENT: '1' },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    };
    let child: ChildProcess;
    try {
      child = spawn(file, args, spawnOpts);
    } catch (e) {
      resolve({
        stdout: '', stderr: String(e), output: String(e), exitCode: 127, signal: null, timedOut: false, aborted: false, durationMs: 0,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let output = '';
    let timedOut = false;
    let aborted = false;
    const push = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const s = chunk.toString('utf8');
      if (output.length < maxBuffer) output += s;
      if (stream === 'stdout') {
        if (stdout.length < maxBuffer) stdout += s;
      } else if (stderr.length < maxBuffer) stderr += s;
      opts.onData?.(s, stream);
    };
    child.stdout?.on('data', (c: Buffer) => push(c, 'stdout'));
    child.stderr?.on('data', (c: Buffer) => push(c, 'stderr'));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();

    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (opts.adopt) {
            child.stdout?.removeAllListeners('data');
            child.stderr?.removeAllListeners('data');
            child.removeAllListeners('close');
            child.removeAllListeners('error');
            opts.signal?.removeEventListener('abort', onAbort);
            const id = opts.adopt(child, stripAnsi(output));
            settled = true;
            resolve({ stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), output: stripAnsi(output), exitCode: null, signal: null, timedOut: true, aborted: false, durationMs: Date.now() - started, adopted: id });
            return;
          }
          killTree(child, 'SIGTERM');
          setTimeout(() => killTree(child, 'SIGKILL'), 3000).unref();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      aborted = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 2000).unref();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        output: stripAnsi(output),
        exitCode: code,
        signal: sig,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (err) => {
      stderr += String(err);
      output += String(err);
      finish(127, null);
    });
    child.on('close', (code, sig) => finish(code, sig));
  });
}

const SIGNAL_NOTES: Record<string, string> = {
  SIGKILL: 'often the kernel OOM killer on memory exhaustion, or an explicit kill -9',
  SIGTERM: 'terminated (timeout, interrupt or external kill)',
  SIGSEGV: 'segmentation fault — the program crashed accessing invalid memory',
  SIGABRT: 'aborted — usually a failed assertion or uncaught native exception',
  SIGPIPE: 'broken pipe — the reader went away',
  SIGXCPU: 'CPU time limit exceeded',
  SIGXFSZ: 'file size limit exceeded',
  SIGINT: 'interrupted',
  SIGBUS: 'bus error — misaligned or invalid memory access',
};

const SIGNAL_NUMBERS: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 6: 'SIGABRT', 7: 'SIGBUS', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM', 24: 'SIGXCPU', 25: 'SIGXFSZ' };

/** Human explanation for exit codes and signals (so the model doesn't guess). */
export function explainExit(code: number | null, signal: NodeJS.Signals | null): string | undefined {
  if (signal) return `terminated by signal ${signal}${SIGNAL_NOTES[signal] ? `: ${SIGNAL_NOTES[signal]}` : ''}`;
  if (code === null) return undefined;
  if (code > 128 && code < 160) {
    const name = SIGNAL_NUMBERS[code - 128];
    if (name) return `exit ${code} usually means terminated by signal ${code - 128} (${name})${SIGNAL_NOTES[name] ? `: ${SIGNAL_NOTES[name]}` : ''}`;
  }
  if (code === 127) return 'command not found';
  if (code === 126) return 'command found but not executable (permissions?)';
  return undefined;
}

/** Check whether a binary is on PATH. */
export async function which(bin: string): Promise<string | null> {
  const cmd = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
  const r = await runShell(cmd, { timeoutMs: 5000 });
  return r.exitCode === 0 ? r.stdout.trim().split('\n')[0] ?? null : null;
}
