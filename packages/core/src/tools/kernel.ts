import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { stripAnsi } from '../util/text.js';
import { killTree } from '../util/process.js';

/**
 * Persistent code kernels (after Hermes' code_kernel): one Python or JavaScript process per
 * session, one cell per execute_code call, and variables, imports and loaded data survive between
 * calls — like a notebook. A cell that times out or is interrupted kills its kernel (state is lost
 * on purpose: a wedged cell cannot be stopped in place safely). Idle kernels stop after 15 minutes.
 *
 * Wire protocol: one JSON request per stdin line; the result comes back on stdout as
 * `<sentinel> <length>\n<json>` with a random per-kernel sentinel. Everything else on stdout is the
 * cell's own raw output.
 */

const PY_RUNNER = String.raw`
import ast, contextlib, io, json, os, sys, traceback
SENT = os.environ.pop("KRONOS_KERNEL_SENTINEL")
G = {"__name__": "__main__", "__builtins__": __builtins__}
out_fd = sys.stdout
def reply(obj):
    data = json.dumps(obj)
    out_fd.write("%s %d\n%s" % (SENT, len(data.encode("utf-8")), data)); out_fd.flush()
for line in sys.stdin:
    req = json.loads(line)
    buf = io.StringIO()
    status, value, err = "ok", None, ""
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            tree = ast.parse(req["code"], "<cell>", "exec")
            last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            exec(compile(tree, "<cell>", "exec"), G)
            if last is not None:
                v = eval(compile(ast.Expression(last.value), "<cell>", "eval"), G)
                if v is not None:
                    value = repr(v)
    except BaseException:
        status, err = "error", traceback.format_exc(limit=8)
    reply({"id": req["id"], "status": status, "output": buf.getvalue()[-200000:], "value": (value or "")[-20000:], "error": err[-20000:]})
`;

const JS_RUNNER = String.raw`
const vm = require('node:vm');
const util = require('node:util');
const readline = require('node:readline');
const SENT = process.env.KRONOS_KERNEL_SENTINEL; delete process.env.KRONOS_KERNEL_SENTINEL;
const write = process.stdout.write.bind(process.stdout);
let buf = '';
const capture = (...a) => { buf += a.map((x) => typeof x === 'string' ? x : util.inspect(x, { depth: 4 })).join(' ') + '\n'; };
const ctx = vm.createContext({ require, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, fetch: globalThis.fetch, structuredClone, TextEncoder, TextDecoder,
  console: { log: capture, info: capture, warn: capture, error: capture, debug: capture, table: capture, dir: capture } });
const reply = (o) => { const d = JSON.stringify(o); write(SENT + ' ' + Buffer.byteLength(d) + '\n' + d); };
const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on('line', (line) => { chain = chain.then(async () => {
  const req = JSON.parse(line); buf = '';
  try {
    let v;
    try { v = vm.runInContext(req.code, ctx, { filename: 'cell.js' }); }
    catch (e) { if (!e || e.name !== 'SyntaxError' || !/await|return/.test(String(e.message))) throw e; v = vm.runInContext('(async () => {\n' + req.code + '\n})()', ctx, { filename: 'cell.js' }); }
    if (v && typeof v.then === 'function') v = await v;
    reply({ id: req.id, status: 'ok', output: buf.slice(-200000), value: v === undefined ? '' : util.inspect(v, { depth: 4 }).slice(-20000), error: '' });
  } catch (e) { reply({ id: req.id, status: 'error', output: buf.slice(-200000), value: '', error: String((e && e.stack) || e).slice(-20000) }); }
}); });
`;

export interface CellResult {
  status: 'ok' | 'error' | 'timeout' | 'interrupted' | 'died';
  output: string;
  value: string;
  error: string;
  /** cells run in this kernel so far */
  count: number;
}

class Kernel {
  child: ChildProcess;
  sentinel = randomBytes(12).toString('hex');
  buf = '';
  raw = '';
  waiting?: (r: { id: number; status: 'ok' | 'error'; output: string; value: string; error: string }) => void;
  lastUsed = Date.now();
  count = 0;
  dead = false;

  constructor(readonly language: 'python' | 'javascript', file: string, args: string[], cwd: string, env: Record<string, string>) {
    this.child = spawn(file, args, { cwd, env: { ...process.env, ...env, KRONOS_KERNEL_SENTINEL: this.sentinel, PYTHONUNBUFFERED: '1', KRONOS_AGENT: '1' }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.child.stdout?.on('data', (c: Buffer) => this.onData(c.toString('utf8')));
    this.child.stderr?.on('data', (c: Buffer) => (this.raw += c.toString('utf8')).length > 400_000 && (this.raw = this.raw.slice(-200_000)));
    this.child.on('exit', () => (this.dead = true));
    this.child.on('error', (e) => ((this.dead = true), (this.raw += String(e))));
  }

  private onData(s: string): void {
    this.buf += s;
    for (;;) {
      const at = this.buf.indexOf(`${this.sentinel} `);
      if (at < 0) {
        // keep a possible partial sentinel at the end
        const keep = this.sentinel.length + 12;
        if (this.buf.length > keep) {
          this.raw += this.buf.slice(0, -keep);
          this.buf = this.buf.slice(-keep);
        }
        return;
      }
      this.raw += this.buf.slice(0, at);
      const nl = this.buf.indexOf('\n', at);
      if (nl < 0) return;
      const len = Number(this.buf.slice(at + this.sentinel.length + 1, nl));
      const body = Buffer.from(this.buf.slice(nl + 1), 'utf8');
      if (body.length < len) return;
      const json = body.subarray(0, len).toString('utf8');
      this.buf = body.subarray(len).toString('utf8');
      try {
        this.waiting?.(JSON.parse(json));
      } catch {
        /* ignore */
      }
    }
  }

  run(code: string, timeoutMs: number, signal?: AbortSignal): Promise<CellResult> {
    this.lastUsed = Date.now();
    this.count++;
    this.raw = '';
    const id = this.count;
    return new Promise((resolve) => {
      const finish = (r: Omit<CellResult, 'count'>) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiting = undefined;
        resolve({ ...r, output: stripAnsi(this.raw + r.output), count: this.count });
      };
      const kill = (status: 'timeout' | 'interrupted') => {
        this.stop();
        finish({ status, output: '', value: '', error: '' });
      };
      const timer = setTimeout(() => kill('timeout'), timeoutMs);
      const onAbort = () => kill('interrupted');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.child.once('exit', () => this.waiting && finish({ status: 'died', output: '', value: '', error: this.raw.slice(-4000) }));
      this.waiting = (r) => r.id === id && finish(r);
      this.child.stdin?.write(`${JSON.stringify({ id, code })}\n`);
    });
  }

  stop(): void {
    this.dead = true;
    killTree(this.child, 'SIGKILL');
  }
}

export class KernelManager {
  private kernels = new Map<string, Kernel>();
  private sweeper?: NodeJS.Timeout;

  constructor(private idleMs = 15 * 60_000) {}

  key(sessionId: string, language: string, cwd: string): string {
    return `${sessionId}\0${language}\0${cwd}`;
  }

  has(sessionId: string, language: string, cwd: string): boolean {
    const k = this.kernels.get(this.key(sessionId, language, cwd));
    return Boolean(k && !k.dead);
  }

  /**
   * Run a cell in the session's kernel, starting it (through `wrap`, e.g. the OS sandbox) when
   * needed. `bin` is the interpreter.
   */
  async run(opts: {
    sessionId: string;
    language: 'python' | 'javascript';
    bin: string;
    cwd: string;
    code: string;
    timeoutMs: number;
    reset?: boolean;
    signal?: AbortSignal;
    wrap?: (file: string, args: string[]) => { file: string; args: string[]; env?: Record<string, string> } | { error: string };
  }): Promise<CellResult & { fresh: boolean }> {
    const key = this.key(opts.sessionId, opts.language, opts.cwd);
    let k = this.kernels.get(key);
    if (k && (k.dead || opts.reset)) {
      k.stop();
      this.kernels.delete(key);
      k = undefined;
    }
    const fresh = !k;
    if (!k) {
      const args = opts.language === 'python' ? ['-u', '-c', PY_RUNNER] : ['-e', JS_RUNNER];
      const w = opts.wrap ? opts.wrap(opts.bin, args) : { file: opts.bin, args };
      if ('error' in w) return { status: 'died', output: '', value: '', error: w.error, count: 0, fresh };
      k = new Kernel(opts.language, w.file, w.args, opts.cwd, w.env ?? {});
      this.kernels.set(key, k);
      this.sweep();
    }
    const r = await k.run(opts.code, opts.timeoutMs, opts.signal);
    if (k.dead) this.kernels.delete(key);
    return { ...r, fresh };
  }

  stopSession(sessionId: string): void {
    for (const [key, k] of this.kernels) if (key.startsWith(`${sessionId}\0`)) (k.stop(), this.kernels.delete(key));
  }

  private sweep(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      for (const [key, k] of this.kernels) if (k.dead || Date.now() - k.lastUsed > this.idleMs) (k.stop(), this.kernels.delete(key));
      if (!this.kernels.size && this.sweeper) (clearInterval(this.sweeper), (this.sweeper = undefined));
    }, 60_000);
    this.sweeper.unref();
  }

  close(): void {
    for (const k of this.kernels.values()) k.stop();
    this.kernels.clear();
  }
}
