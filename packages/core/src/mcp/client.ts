import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServerConfig } from '../config/schema.js';
import type { ImagePart, JSONSchema } from '../types.js';
import { killTree } from '../util/process.js';
import { logger } from '../util/log.js';

const log = logger('mcp');
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpCallResult {
  text: string;
  images: ImagePart[];
  isError: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Minimal MCP client (JSON-RPC 2.0) over stdio or Streamable HTTP. */
export class McpClient {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private sessionId?: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  stderrTail = '';

  constructor(readonly name: string, private cfg: McpServerConfig) {}

  get transport(): 'stdio' | 'http' {
    return this.cfg.url ? 'http' : 'stdio';
  }

  async connect(): Promise<void> {
    if (this.transport === 'stdio') this.spawnStdio();
    const res = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'kronos-agent', version: '1.0.0' },
    })) as { serverInfo?: { name?: string; version?: string }; instructions?: string };
    this.serverInfo = res?.serverInfo;
    this.instructions = res?.instructions;
    await this.notify('notifications/initialized', {});
  }

  private spawnStdio(): void {
    if (!this.cfg.command) throw new Error(`MCP server "${this.name}" has neither command nor url`);
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.cfg.cwd,
      env: { ...process.env, ...this.cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32',
    });
    this.child = child;
    child.stdout?.on('data', (b: Buffer) => this.onData(b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => {
      this.stderrTail = (this.stderrTail + b.toString('utf8')).slice(-4000);
    });
    child.on('exit', (code) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server "${this.name}" exited (${code}). ${this.stderrTail.trim().slice(-500)}`));
      }
      this.pending.clear();
      this.child = undefined;
    });
    child.on('error', (e) => log.warn(`mcp ${this.name} spawn error`, e));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch {
        log.debug(`mcp ${this.name} non-json line: ${line.slice(0, 200)}`);
      }
    }
  }

  private handleMessage(msg: { id?: number | string; result?: unknown; error?: { message?: string; code?: number }; method?: string }): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? `MCP error ${msg.error.code}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // server → client requests (ping, roots/list, sampling): answer politely
      const result = msg.method === 'roots/list' ? { roots: [] } : {};
      void this.send({ jsonrpc: '2.0', id: msg.id, result });
    }
  }

  private async send(payload: unknown): Promise<unknown> {
    if (this.transport === 'stdio') {
      if (!this.child?.stdin) throw new Error(`MCP server "${this.name}" is not running`);
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      return undefined;
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      ...this.cfg.headers,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(this.cfg.url as string, { method: 'POST', headers, body: JSON.stringify(payload) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return undefined;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const ctype = res.headers.get('content-type') ?? '';
    if (ctype.includes('text/event-stream')) {
      const text = await res.text();
      for (const block of text.split(/\n\n/)) {
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (data) {
          try {
            this.handleMessage(JSON.parse(data));
          } catch {
            /* ignore */
          }
        }
      }
      return undefined;
    }
    const body = await res.text();
    if (body.trim()) {
      const j = JSON.parse(body);
      for (const m of Array.isArray(j) ? j : [j]) this.handleMessage(m);
    }
    return undefined;
  }

  request(method: string, params: unknown, timeoutMs = this.cfg.timeoutMs ?? 60_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${this.name}" ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params }).catch((e: Error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.send({ jsonrpc: '2.0', method, params });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const res = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(res?.tools ?? []));
      cursor = res?.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpCallResult> {
    const res = (await this.request('tools/call', { name, arguments: args }, timeoutMs ?? this.cfg.timeoutMs ?? 300_000)) as {
      content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string } }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const texts: string[] = [];
    const images: ImagePart[] = [];
    for (const c of res?.content ?? []) {
      if (c.type === 'text' && c.text) texts.push(c.text);
      else if (c.type === 'image' && c.data) images.push({ type: 'image', mediaType: c.mimeType ?? 'image/png', data: c.data });
      else if (c.type === 'resource' && c.resource) texts.push(c.resource.text ?? `[resource ${c.resource.uri}]`);
      else if (c.type === 'resource_link') texts.push(`[resource ${(c as { uri?: string }).uri ?? ''}]`);
    }
    if (!texts.length && res?.structuredContent !== undefined) texts.push(JSON.stringify(res.structuredContent, null, 2));
    return { text: texts.join('\n'), images, isError: Boolean(res?.isError) };
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    if (this.child) killTree(this.child);
    this.child = undefined;
  }
}
