import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Kronos, KRONOS_VERSION, newId, logger, errorMessage, type PermissionMode, type PermissionDecision } from '@kronos/core';
import * as core from '@kronos/core';
import { Hub, type HubClient } from './hub.js';
import { buildApi } from './api.js';
import { buildOpenAIRoutes } from './openai.js';
import { attachTerminal } from './terminal.js';
import { readBody, sendJson, serveStatic, type Router } from './http.js';
import { PlatformManager } from './platforms/manager.js';
import type { WhatsAppAdapter } from './platforms/others.js';

const log = logger('gateway');

export interface GatewayOptions {
  host?: string;
  port?: number;
  token?: string;
  uiDir?: string;
  /** start messaging platform adapters (default true) */
  platforms?: boolean;
  /** start the cron scheduler (default true) */
  cron?: boolean;
  quiet?: boolean;
}

function findUiDir(explicit?: string): string | undefined {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env.KRONOS_UI_DIR) candidates.push(process.env.KRONOS_UI_DIR);
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    candidates.push(resolve(here, '../../../apps/web/dist'), resolve(here, '../web'), resolve(here, '../../web/dist'));
  } catch {
    /* bundled */
  }
  return candidates.find((c) => existsSync(resolve(c, 'index.html')));
}

const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

const FALLBACK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Kronos</title><style>body{font-family:system-ui;background:#0e0f13;color:#e8e6df;display:grid;place-items:center;height:100vh;margin:0}code{background:#22242c;padding:2px 6px;border-radius:4px}</style></head><body><div><h1>⏳ Kronos gateway is running</h1><p>The web UI is not built yet. Run <code>npm run build:web</code> and reload.</p><p>API: <code>/api/status</code> · OpenAI-compatible: <code>/v1/chat/completions</code></p></div></body></html>`;

/**
 * The Kronos gateway: HTTP API + WebSocket streaming for the desktop/web UI, a PTY terminal,
 * an OpenAI-compatible endpoint, messaging platform adapters, webhooks and the cron scheduler.
 */
export class Gateway {
  rt: Kronos;
  readonly hub: Hub;
  readonly platforms: PlatformManager;
  readonly core = core;
  server!: Server;
  url = '';
  token: string;
  private api!: Router;
  private openai!: Router;
  private wss!: WebSocketServer;
  private uiDir?: string;
  private opts: GatewayOptions;

  private constructor(rt: Kronos, opts: GatewayOptions) {
    this.rt = rt;
    this.opts = opts;
    this.hub = new Hub(rt);
    this.platforms = new PlatformManager(() => this.rt);
    const host = opts.host ?? rt.config.gateway.host;
    this.token = opts.token ?? rt.config.gateway.token ?? '';
    if (!this.token && !isLoopback(host)) {
      this.token = randomBytes(18).toString('base64url');
      log.warn('gateway bound to a non-loopback address without a token — generated one');
    }
  }

  static async start(rt: Kronos, opts: GatewayOptions = {}): Promise<Gateway> {
    const gw = new Gateway(rt, opts);
    await gw.listen();
    return gw;
  }

  private installRuntime(): void {
    this.rt.messaging = (platform, target, text) => this.platforms.send(platform, target, text);
    if (this.opts.cron !== false && this.rt.config.cron.enabled) this.rt.cron.start();
  }

  private async listen(): Promise<void> {
    this.uiDir = findUiDir(this.opts.uiDir);
    this.api = buildApi(this);
    this.openai = buildOpenAIRoutes(this);
    this.installRuntime();
    this.server = createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!this.authorized(req, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      if (url.pathname === '/ws' || url.pathname === '/ws/terminal') {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          if (url.pathname === '/ws') this.onClient(ws);
          else
            attachTerminal(ws, {
              cwd: url.searchParams.get('cwd') || this.rt.workspace(),
              cols: Number(url.searchParams.get('cols') ?? 100),
              rows: Number(url.searchParams.get('rows') ?? 30),
            });
        });
      } else socket.destroy();
    });
    const host = this.opts.host ?? this.rt.config.gateway.host;
    const port = this.opts.port ?? this.rt.config.gateway.port;
    await new Promise<void>((resolveListen, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolveListen());
    });
    const addr = this.server.address();
    const realPort = typeof addr === 'object' && addr ? addr.port : port;
    this.url = `http://${host.includes(':') ? `[${host}]` : host}:${realPort}`;
    if (this.opts.platforms !== false) await this.platforms.startAll();
    log.info(`gateway listening on ${this.url}`);
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    if (!this.token) return true;
    const candidates = [
      (req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''),
      url.searchParams.get('token') ?? '',
      /(?:^|;\s*)kronos_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '',
    ];
    const want = Buffer.from(this.token);
    return candidates.some((c) => {
      const got = Buffer.from(decodeURIComponent(c));
      return got.length === want.length && timingSafeEqual(got, want);
    });
  }

  private cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = this.rt.config.gateway.cors ?? [];
    if (allowed.includes('*') || allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-kronos-session');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    this.cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      // public webhooks (verified by their own secrets)
      if (url.pathname.startsWith('/hooks/')) return await this.hooks(req, res, url);
      const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/');
      if (isApi && !this.authorized(req, url) && url.pathname !== '/api/health') {
        sendJson(res, 401, { error: 'unauthorized — pass the gateway token as Bearer, ?token= or cookie' });
        return;
      }
      if (url.searchParams.get('token') && this.token && this.authorized(req, url)) {
        res.setHeader('set-cookie', `kronos_token=${encodeURIComponent(this.token)}; Path=/; HttpOnly; SameSite=Strict`);
      }
      if (url.pathname.startsWith('/v1/')) {
        if (await this.openai.handle(req, res)) return;
      } else if (url.pathname.startsWith('/api/')) {
        if (await this.api.handle(req, res)) return;
        sendJson(res, 404, { error: `no route ${req.method} ${url.pathname}` });
        return;
      }
      if (this.uiDir) {
        if (this.token && !this.authorized(req, url) && !/\.(js|css|svg|png|woff2?|ico)$/.test(url.pathname)) {
          res.writeHead(401, { 'content-type': 'text/html' });
          res.end('<h1>401</h1><p>Open the URL printed by <code>kronos gateway</code> (it includes ?token=…).</p>');
          return;
        }
        if (serveStatic(this.uiDir, req, res)) return;
      } else if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(FALLBACK_PAGE);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: errorMessage(e) });
    }
  }

  private async hooks(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const cfg = this.rt.config.platforms;
    if (url.pathname === '/hooks/whatsapp') {
      if (req.method === 'GET') {
        const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === cfg.whatsapp.verifyToken;
        res.writeHead(ok ? 200 : 403);
        res.end(ok ? (url.searchParams.get('hub.challenge') ?? '') : 'forbidden');
        return;
      }
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      (this.platforms.get('whatsapp') as WhatsAppAdapter | undefined)?.receive(body);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/hooks/webhook') {
      if (!cfg.webhook.enabled) return sendJson(res, 404, { error: 'webhook platform disabled' });
      const secret = (req.headers['x-kronos-secret'] as string | undefined) ?? url.searchParams.get('secret') ?? '';
      if (!cfg.webhook.secret || secret !== cfg.webhook.secret) return sendJson(res, 401, { error: 'bad secret' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { text?: string; chat?: string; user?: string; model?: string };
      if (!body.text) return sendJson(res, 400, { error: 'text is required' });
      sendJson(res, 200, await this.platforms.webhook(body));
      return;
    }
    sendJson(res, 404, { error: 'unknown hook' });
  }

  // -------------------------------------------------------------------------
  // WebSocket protocol
  // -------------------------------------------------------------------------

  private onClient(ws: WebSocket): void {
    const client: HubClient = {
      id: newId('c_'),
      subscriptions: new Set(),
      send: (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    this.hub.addClient(client);
    const model = this.rt.providers.resolve();
    client.send({
      type: 'ready',
      version: KRONOS_VERSION,
      clientId: client.id,
      profile: this.rt.profile,
      model,
      demo: model.provider === 'kronos',
      running: this.hub.runningList(),
      pending: this.hub.pending(),
    });
    const alive = setInterval(() => client.send({ type: 'ping', t: Date.now() }), 25_000);
    ws.on('close', () => {
      clearInterval(alive);
      this.hub.removeClient(client.id);
    });
    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      void this.onClientMessage(client, msg).catch((e) => client.send({ type: 'error', message: errorMessage(e), requestId: msg.requestId }));
    });
  }

  private async onClientMessage(client: HubClient, msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
    switch (msg.type) {
      case 'subscribe':
        if (sessionId) client.subscriptions.add(sessionId);
        break;
      case 'unsubscribe':
        if (sessionId) client.subscriptions.delete(sessionId);
        break;
      case 'chat': {
        const r = await this.hub.chat({
          sessionId,
          text: String(msg.text ?? ''),
          images: msg.images as never,
          files: msg.files as never,
          model: msg.model as string | undefined,
          mode: msg.mode as PermissionMode | undefined,
          cwd: msg.cwd as string | undefined,
          interrupt: Boolean(msg.interrupt),
          source: 'desktop',
        });
        client.subscriptions.add(r.sessionId);
        client.send({ type: 'chat_ack', requestId: msg.requestId, sessionId: r.sessionId, queued: r.queued });
        break;
      }
      case 'stop':
        if (sessionId) this.hub.stop(sessionId);
        break;
      case 'unqueue':
        if (sessionId) this.hub.removeQueued(sessionId, String(msg.id));
        break;
      case 'permission':
        this.hub.respondPermission(sessionId ?? '', String(msg.requestId), { decision: msg.decision, feedback: msg.feedback } as PermissionDecision);
        break;
      case 'clarify':
        this.hub.respondClarify(sessionId ?? '', String(msg.requestId), String(msg.answer ?? ''));
        break;
      case 'set_mode':
        if (sessionId) this.rt.agent(sessionId).setMode(msg.mode as PermissionMode);
        break;
      case 'set_model':
        if (sessionId) this.rt.agent(sessionId).setModel(String(msg.model));
        break;
      case 'pong':
      case 'ping':
        break;
      default:
        client.send({ type: 'error', message: `unknown message type ${String(msg.type)}` });
    }
  }

  /** Swap the runtime to another profile without restarting the server. */
  async switchProfile(profile: string): Promise<void> {
    const old = this.rt;
    await this.platforms.stopAll();
    const next = await Kronos.create({ home: old.home, profile, cwd: old.cwd });
    await old.close();
    this.rt = next;
    this.hub.attach(next);
    this.installRuntime();
    if (this.opts.platforms !== false) await this.platforms.startAll();
    this.hub.broadcast({ type: 'profile_changed', profile });
  }

  async close(): Promise<void> {
    await this.platforms.stopAll();
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((r) => this.server.close(() => r()));
    await this.rt.close();
  }
}
