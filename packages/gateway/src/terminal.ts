import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { WebSocket } from 'ws';

/**
 * A real PTY without native modules: a ~30 line Python bridge (pty.fork + TIOCSWINSZ)
 * gives full-screen apps (vim, htop) and resizing. Falls back to `script(1)` and then to
 * plain pipes (Windows).
 */
const PY_BRIDGE = `
import os, pty, sys, select, struct, fcntl, termios, signal
cols, rows = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLUMNS'] = str(cols); os.environ['LINES'] = str(rows)
    os.execvp(argv[0], argv)
def setsize(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    try: os.kill(pid, signal.SIGWINCH)
    except Exception: pass
setsize(cols, rows)
ctl = 3
buf = b''
while True:
    try:
        r, _, _ = select.select([fd, 0, ctl], [], [])
    except InterruptedError:
        continue
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data: break
        os.write(fd, data)
    if ctl in r:
        data = os.read(ctl, 1024)
        if not data:
            ctl = -1
            continue
        buf += data
        while b'\\n' in buf:
            line, buf = buf.split(b'\\n', 1)
            try:
                c, rr = line.split()
                setsize(int(c), int(rr))
            except Exception: pass
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
`;

let pythonBin: string | null | undefined;
function findPython(): string | null {
  if (pythonBin !== undefined) return pythonBin;
  for (const p of ['python3', 'python']) {
    const r = spawnSync(p, ['-c', 'import pty, termios'], { stdio: 'ignore' });
    if (r.status === 0) return (pythonBin = p);
  }
  return (pythonBin = null);
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe';
  return process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

export interface TerminalOptions {
  cwd: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

export function attachTerminal(ws: WebSocket, opts: TerminalOptions): void {
  const shell = opts.shell ?? defaultShell();
  const cols = Math.max(20, Math.min(500, opts.cols ?? 100));
  const rows = Math.max(5, Math.min(200, opts.rows ?? 30));
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', KRONOS_TERMINAL: '1' };
  let child: ChildProcess;
  let mode: 'pty' | 'script' | 'pipe';
  const py = process.platform !== 'win32' ? findPython() : null;
  if (py) {
    child = spawn(py, ['-u', '-c', PY_BRIDGE, String(cols), String(rows), shell, '-l'], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    mode = 'pty';
  } else if (process.platform === 'linux' && existsSync('/usr/bin/script')) {
    child = spawn('script', ['-qfc', `${shell} -l`, '/dev/null'], { cwd: opts.cwd, env: { ...env, COLUMNS: String(cols), LINES: String(rows) } });
    mode = 'script';
  } else {
    child = spawn(shell, process.platform === 'win32' ? [] : ['-i'], { cwd: opts.cwd, env });
    mode = 'pipe';
  }
  const send = (msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  send({ type: 'ready', mode, shell, cwd: opts.cwd });
  child.stdout?.on('data', (b: Buffer) => send({ type: 'output', data: b.toString('utf8') }));
  child.stderr?.on('data', (b: Buffer) => send({ type: 'output', data: b.toString('utf8') }));
  child.on('exit', (code) => {
    send({ type: 'exit', code });
    ws.close();
  });
  child.on('error', (e) => send({ type: 'output', data: `\r\n[terminal error] ${e.message}\r\n` }));
  ws.on('message', (raw) => {
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      // pipe mode has no line discipline: translate CR to LF so commands run
      child.stdin?.write(mode === 'pipe' ? msg.data.replace(/\r/g, '\n') : msg.data);
    } else if (msg.type === 'resize' && mode === 'pty' && msg.cols && msg.rows) {
      const ctl = child.stdio[3] as NodeJS.WritableStream | null;
      ctl?.write(`${Math.floor(msg.cols)} ${Math.floor(msg.rows)}\n`);
    }
  });
  ws.on('close', () => {
    try {
      child.kill('SIGHUP');
    } catch {
      /* gone */
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, 2000).unref();
  });
}
