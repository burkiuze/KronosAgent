import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { relative, isAbsolute } from 'node:path';
import type { KronosConfig } from '../config/schema.js';
import { defaultShell, killTree, runProcess, runShell, shellArgs, type RunOptions, type RunResult } from '../util/process.js';
import { describeSandbox, ensureNetworkProxy, proxiedNetwork, runningNetworkProxy, wrapCommand, type SandboxConfig } from './sandbox.js';
import { newId } from '../util/misc.js';
import { stripAnsi } from '../util/text.js';

export interface ExecOptions extends Omit<RunOptions, 'shell'> {
  cwd: string;
}

export interface ExecBackend {
  readonly name: string;
  exec(command: string, opts: ExecOptions): Promise<RunResult>;
  describe(): string;
  dispose?(): Promise<void>;
}

/** `shell -c command`, inside the OS sandbox when one is configured. */
export function sandboxedShell(command: string, cwd: string, shell: string, sandbox?: SandboxConfig): { file: string; args: string[]; env?: Record<string, string> } | { error: string } {
  const args = shellArgs(shell, command);
  if (!sandbox || sandbox.mode === 'off') return { file: shell, args };
  const wrapped = wrapCommand(shell, args, cwd, sandbox, runningNetworkProxy()?.port);
  if ('error' in wrapped) {
    if (sandbox.fallback === 'unsandboxed') return { file: shell, args };
    return { error: `Not run: the sandbox (terminal.sandbox.mode: ${sandbox.mode}) is not available — ${wrapped.error}. Or set terminal.sandbox.fallback to "unsandboxed".` };
  }
  return wrapped;
}

class LocalBackend implements ExecBackend {
  readonly name = 'local';
  constructor(private shell?: string, private sandbox?: SandboxConfig) {}
  exec(command: string, opts: ExecOptions): Promise<RunResult> {
    const shell = this.shell || defaultShell();
    if (!this.sandbox || this.sandbox.mode === 'off') return runShell(command, { ...opts, shell });
    const sandbox = this.sandbox;
    return (async () => {
      if (proxiedNetwork(sandbox)) await ensureNetworkProxy(sandbox);
      const cmd = sandboxedShell(command, opts.cwd, shell, sandbox);
      if ('error' in cmd) return { stdout: '', stderr: cmd.error, output: cmd.error, exitCode: 126, signal: null, timedOut: false, aborted: false, durationMs: 0 };
      return runProcess(cmd.file, cmd.args, { ...opts, env: { ...opts.env, ...cmd.env } });
    })();
  }
  describe(): string {
    const sb = describeSandbox(this.sandbox);
    return `local (${this.shell || defaultShell()})${sb ? `, ${sb}` : ''}`;
  }
}

/** One persistent container per workspace; every command runs via `docker exec`. */
class DockerBackend implements ExecBackend {
  readonly name = 'docker';
  private container?: string;
  private starting?: Promise<string>;
  constructor(private cfg: KronosConfig['terminal']['docker'], private workspace: string) {}

  private async ensure(): Promise<string> {
    if (this.container) return this.container;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const name = `kronos-${createHash('sha1').update(this.workspace).digest('hex').slice(0, 10)}`;
      const existing = await runProcess('docker', ['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 15_000 });
      if (existing.exitCode === 0 && existing.stdout.trim() === 'true') return name;
      if (existing.exitCode === 0) await runProcess('docker', ['rm', '-f', name], { timeoutMs: 15_000 });
      const args = [
        'run', '-d', '--name', name, '--init',
        '-v', `${this.workspace}:${this.cfg.workdir}`, '-w', this.cfg.workdir,
        '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
        ...(this.cfg.network ? [] : ['--network', 'none']),
        ...this.cfg.extraArgs,
        this.cfg.image, 'sleep', 'infinity',
      ];
      const r = await runProcess('docker', args, { timeoutMs: 300_000 });
      if (r.exitCode !== 0) throw new Error(`could not start docker sandbox: ${r.stderr || r.output}`);
      return name;
    })();
    this.container = await this.starting;
    return this.container;
  }

  private mapCwd(cwd: string): string {
    const rel = relative(this.workspace, cwd);
    if (rel.startsWith('..') || isAbsolute(rel)) return this.cfg.workdir;
    return rel ? `${this.cfg.workdir}/${rel.split('\\').join('/')}` : this.cfg.workdir;
  }

  async exec(command: string, opts: ExecOptions): Promise<RunResult> {
    const name = await this.ensure();
    return runProcess('docker', ['exec', '-i', '-w', this.mapCwd(opts.cwd), name, 'bash', '-lc', command], opts);
  }

  describe(): string {
    return `docker (${this.cfg.image}, workspace mounted at ${this.cfg.workdir})`;
  }

  async dispose(): Promise<void> {
    if (this.container) await runProcess('docker', ['rm', '-f', this.container], { timeoutMs: 20_000 });
    this.container = undefined;
  }
}

class SshBackend implements ExecBackend {
  readonly name = 'ssh';
  constructor(private cfg: KronosConfig['terminal']['ssh']) {}
  private target(): string {
    return this.cfg.user ? `${this.cfg.user}@${this.cfg.host}` : this.cfg.host;
  }
  exec(command: string, opts: ExecOptions): Promise<RunResult> {
    if (!this.cfg.host) throw new Error('terminal.ssh.host is not configured');
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
    if (this.cfg.port) args.push('-p', String(this.cfg.port));
    if (this.cfg.key) args.push('-i', this.cfg.key);
    const dir = this.cfg.workdir ? `cd ${JSON.stringify(this.cfg.workdir)} && ` : '';
    args.push(this.target(), `${dir}${command}`);
    return runProcess('ssh', args, opts);
  }
  describe(): string {
    return `ssh (${this.target()}${this.cfg.workdir ? `:${this.cfg.workdir}` : ''})`;
  }
}

export function createBackend(cfg: KronosConfig['terminal'], workspace: string): ExecBackend {
  switch (cfg.backend) {
    case 'docker':
      return new DockerBackend(cfg.docker, workspace);
    case 'ssh':
      return new SshBackend(cfg.ssh);
    default:
      return new LocalBackend(cfg.shell, cfg.sandbox);
  }
}

// ---------------------------------------------------------------------------
// Background processes (dev servers, watchers, long builds)
// ---------------------------------------------------------------------------

export interface BackgroundProcess {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  startedAt: number;
  exitCode: number | null;
  running: boolean;
  sessionId?: string;
}

const MAX_BUFFER = 400_000;

export class ProcessManager {
  private procs = new Map<string, { info: BackgroundProcess; child: ChildProcess; output: string; readOffset: number }>();

  start(command: string, cwd: string, sessionId?: string, shell = defaultShell(), sandbox?: SandboxConfig): BackgroundProcess {
    const cmd = sandboxedShell(command, cwd, shell, sandbox);
    if ('error' in cmd) throw new Error(cmd.error);
    const child = spawn(cmd.file, cmd.args, {
      cwd,
      env: { ...process.env, KRONOS_AGENT: '1', FORCE_COLOR: '0', ...cmd.env },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const info: BackgroundProcess = { id: newId('p_'), command, cwd, pid: child.pid, startedAt: Date.now(), exitCode: null, running: true, sessionId };
    const entry = { info, child, output: '', readOffset: 0 };
    const push = (b: Buffer) => {
      entry.output += stripAnsi(b.toString('utf8'));
      if (entry.output.length > MAX_BUFFER) {
        const cut = entry.output.length - MAX_BUFFER;
        entry.output = entry.output.slice(cut);
        entry.readOffset = Math.max(0, entry.readOffset - cut);
      }
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('close', (code) => {
      info.running = false;
      info.exitCode = code;
    });
    child.on('error', (e) => {
      entry.output += `\n[process error] ${e.message}`;
      info.running = false;
    });
    this.procs.set(info.id, entry);
    return info;
  }

  /** Take over a running child (a foreground command past its timeout) as a background process. */
  adopt(child: ChildProcess, command: string, cwd: string, initialOutput: string, sessionId?: string): BackgroundProcess {
    const info: BackgroundProcess = { id: newId('p_'), command, cwd, pid: child.pid, startedAt: Date.now(), exitCode: null, running: true, sessionId };
    const entry = { info, child, output: initialOutput.slice(-MAX_BUFFER), readOffset: initialOutput.length > MAX_BUFFER ? MAX_BUFFER : initialOutput.length };
    const push = (b: Buffer) => {
      entry.output += stripAnsi(b.toString('utf8'));
      if (entry.output.length > MAX_BUFFER) {
        const cut = entry.output.length - MAX_BUFFER;
        entry.output = entry.output.slice(cut);
        entry.readOffset = Math.max(0, entry.readOffset - cut);
      }
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('close', (code) => {
      info.running = false;
      info.exitCode = code;
    });
    child.on('error', (e) => {
      entry.output += `\n[process error] ${e.message}`;
      info.running = false;
    });
    this.procs.set(info.id, entry);
    return info;
  }

  list(sessionId?: string): BackgroundProcess[] {
    return [...this.procs.values()].map((p) => p.info).filter((p) => !sessionId || p.sessionId === sessionId);
  }

  /** Return new output since the last read (or the tail when `all`). */
  output(id: string, opts: { all?: boolean; tail?: number } = {}): string {
    const p = this.procs.get(id);
    if (!p) throw new Error(`no background process ${id}`);
    let out: string;
    if (opts.all) out = p.output;
    else {
      out = p.output.slice(p.readOffset);
      p.readOffset = p.output.length;
    }
    if (opts.tail) out = out.split('\n').slice(-opts.tail).join('\n');
    return out;
  }

  write(id: string, input: string): void {
    const p = this.procs.get(id);
    if (!p) throw new Error(`no background process ${id}`);
    p.child.stdin?.write(input);
  }

  kill(id: string): boolean {
    const p = this.procs.get(id);
    if (!p) return false;
    killTree(p.child, 'SIGTERM');
    setTimeout(() => p.info.running && killTree(p.child, 'SIGKILL'), 3000).unref();
    return true;
  }

  killAll(): void {
    for (const id of this.procs.keys()) this.kill(id);
  }
}
