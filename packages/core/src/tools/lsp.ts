import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../util/log.js';

const log = logger('lsp');

/**
 * Language-server diagnostics after edits (after Hermes' agent/lsp): the edited file is synced to a
 * language server and only the errors the edit introduced are reported — type errors, undefined
 * names, wrong arguments — which a syntax check cannot see. Servers are used when installed, one per
 * project and language, started on first use and stopped after a few idle minutes.
 */

interface ServerDef {
  id: string;
  bins: string[];
  args: string[];
  exts: string[];
  markers: string[];
  languageId: (ext: string) => string;
}

const SERVERS: ServerDef[] = [
  {
    id: 'typescript',
    bins: ['typescript-language-server'],
    args: ['--stdio'],
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    markers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    languageId: (e) => (e === '.tsx' ? 'typescriptreact' : e === '.jsx' ? 'javascriptreact' : /\.[mc]?ts$/.test(e) ? 'typescript' : 'javascript'),
  },
  { id: 'pyright', bins: ['basedpyright-langserver', 'pyright-langserver'], args: ['--stdio'], exts: ['.py', '.pyi'], markers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pyrightconfig.json'], languageId: () => 'python' },
  { id: 'gopls', bins: ['gopls'], args: [], exts: ['.go'], markers: ['go.mod', 'go.work'], languageId: () => 'go' },
  { id: 'rust-analyzer', bins: ['rust-analyzer'], args: [], exts: ['.rs'], markers: ['Cargo.toml'], languageId: () => 'rust' },
  { id: 'clangd', bins: ['clangd'], args: ['--background-index=false'], exts: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp'], markers: ['compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakeLists.txt'], languageId: (e) => (e === '.c' || e === '.h' ? 'c' : 'cpp') },
];

export interface LspDiagnostic {
  line: number;
  col: number;
  message: string;
  source?: string;
  code?: string;
}

function which(bins: string[]): string | undefined {
  for (const b of bins) for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && existsSync(join(dir, b))) return join(dir, b);
  return undefined;
}

function rootFor(file: string, markers: string[], fallback: string): string {
  let dir = dirname(resolve(file));
  for (let i = 0; i < 30; i++) {
    if (markers.some((m) => existsSync(join(dir, m))) || existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return fallback;
}

class LspClient {
  private child: ChildProcess;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, (r: unknown) => void>();
  private diags = new Map<string, { at: number; list: LspDiagnostic[] }>();
  private waiters = new Map<string, () => void>();
  private versions = new Map<string, number>();
  ready: Promise<void>;
  lastUsed = Date.now();
  dead = false;

  constructor(bin: string, def: ServerDef, readonly root: string) {
    this.child = spawn(bin, def.args, { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env } });
    this.child.on('exit', () => (this.dead = true));
    this.child.on('error', () => (this.dead = true));
    this.child.stdout?.on('data', (c: Buffer) => this.onData(c));
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'workspace' }],
      capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false }, synchronization: { didSave: true } }, workspace: { workspaceFolders: true, configuration: true } },
      initializationOptions: {},
    }).then(() => this.notify('initialized', {}));
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const len = Number(/content-length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString())?.[1] ?? -1);
      if (len < 0 || this.buf.length < sep + 4 + len) return;
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(sep + 4 + len);
      try {
        this.onMessage(JSON.parse(body) as Record<string, unknown>);
      } catch {
        /* ignore malformed */
      }
    }
  }

  private onMessage(m: Record<string, unknown>): void {
    if (typeof m.id === 'number' && !m.method) {
      this.pending.get(m.id)?.(m.result);
      this.pending.delete(m.id);
      return;
    }
    if (m.method === 'textDocument/publishDiagnostics') {
      const p = m.params as { uri: string; diagnostics: { range: { start: { line: number; character: number } }; severity?: number; message: string; source?: string; code?: string | number }[] };
      const list = p.diagnostics
        .filter((d) => (d.severity ?? 1) === 1)
        .map((d) => ({ line: d.range.start.line + 1, col: d.range.start.character + 1, message: d.message.split('\n')[0] ?? d.message, source: d.source, code: d.code === undefined ? undefined : String(d.code) }));
      this.diags.set(p.uri, { at: Date.now(), list });
      this.waiters.get(p.uri)?.();
      return;
    }
    // server → client requests: answer so the server does not stall
    if (typeof m.id === 'number' && typeof m.method === 'string') {
      const result = m.method === 'workspace/configuration' ? ((m.params as { items?: unknown[] })?.items ?? []).map(() => null) : null;
      this.send({ jsonrpc: '2.0', id: m.id, result });
    }
  }

  private send(msg: unknown): void {
    if (this.dead) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.child.stdin?.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveP, reject) => {
      const t = setTimeout(() => (this.pending.delete(id), reject(new Error(`${method} timed out`))), timeoutMs);
      this.pending.set(id, (r) => (clearTimeout(t), resolveP(r)));
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Give the server `text` for `file` and wait for its diagnostics (null when it stays silent). */
  async check(file: string, languageId: string, text: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    await this.ready;
    this.lastUsed = Date.now();
    const uri = pathToFileURL(file).href;
    const sentAt = Date.now();
    const got = new Promise<void>((r) => this.waiters.set(uri, r));
    const v = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, v);
    if (v === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: v, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version: v }, contentChanges: [{ text }] });
    await Promise.race([got, new Promise((r) => setTimeout(r, timeoutMs))]);
    // servers often publish twice (syntax, then semantic): let the second one land
    await new Promise((r) => setTimeout(r, 350));
    const d = this.diags.get(uri);
    return d && d.at >= sentAt ? d.list : null;
  }

  stop(): void {
    try {
      this.notify('exit', {});
      this.child.kill();
    } catch {
      /* gone */
    }
    this.dead = true;
  }
}

export class LspManager {
  private clients = new Map<string, LspClient>();
  private sweeper?: NodeJS.Timeout;

  constructor(private idleMs = 5 * 60_000, private maxServers = 3) {}

  private serverFor(file: string): ServerDef | undefined {
    const ext = extname(file).toLowerCase();
    return SERVERS.find((s) => s.exts.includes(ext));
  }

  available(file: string): boolean {
    const def = this.serverFor(file);
    return Boolean(def && which(def.bins));
  }

  private client(file: string, workspace: string): { client: LspClient; def: ServerDef } | undefined {
    const def = this.serverFor(file);
    const bin = def && which(def.bins);
    if (!def || !bin) return undefined;
    const root = rootFor(file, def.markers, workspace);
    const key = `${def.id}:${root}`;
    let c = this.clients.get(key);
    if (c?.dead) {
      this.clients.delete(key);
      c = undefined;
    }
    if (!c) {
      // a bounded number of servers: the least recently used one goes
      if (this.clients.size >= this.maxServers) {
        const [oldKey, old] = [...this.clients.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]!;
        old.stop();
        this.clients.delete(oldKey);
      }
      c = new LspClient(bin, def, root);
      this.clients.set(key, c);
      log.info(`started ${def.id} for ${root}`);
      this.sweep();
    }
    return { client: c, def };
  }

  private sweep(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      for (const [k, c] of this.clients) if (c.dead || Date.now() - c.lastUsed > this.idleMs) (c.stop(), this.clients.delete(k));
      if (!this.clients.size && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = undefined;
      }
    }, 30_000);
    this.sweeper.unref();
  }

  /**
   * Errors the edit introduced: diagnostics of the new text minus those the old text already had
   * (compared by message, so shifted lines still match). Undefined when no server answered.
   */
  async introduced(file: string, before: string | null, after: string, workspace: string, timeoutMs = 4000): Promise<{ server: string; errors: LspDiagnostic[] } | undefined> {
    const c = this.client(file, workspace);
    if (!c) return undefined;
    const lang = c.def.languageId(extname(file).toLowerCase());
    try {
      const now = await c.client.check(file, lang, after, timeoutMs);
      if (!now) return undefined;
      if (!now.length || before === null) return { server: c.def.id, errors: now };
      const old = await c.client.check(file, lang, before, timeoutMs);
      await c.client.check(file, lang, after, timeoutMs); // leave the server on the current text
      const seen = new Map<string, number>();
      for (const d of old ?? []) seen.set(d.message, (seen.get(d.message) ?? 0) + 1);
      const fresh = now.filter((d) => {
        const n = seen.get(d.message) ?? 0;
        if (n > 0) {
          seen.set(d.message, n - 1);
          return false;
        }
        return true;
      });
      return { server: c.def.id, errors: fresh };
    } catch (e) {
      log.debug('lsp check failed', e);
      return undefined;
    }
  }

  close(): void {
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
  }
}

export function formatLspErrors(rel: string, server: string, errors: LspDiagnostic[]): string {
  const shown = errors.slice(0, 12).map((d) => `  ${rel}:${d.line}:${d.col} ${d.message}${d.code ? ` [${d.code}]` : ''}`);
  return `\n\n${server} reports ${errors.length} new error${errors.length === 1 ? '' : 's'} from this edit:\n${shown.join('\n')}${errors.length > 12 ? `\n  … ${errors.length - 12} more` : ''}\nFix them before moving on.`;
}
