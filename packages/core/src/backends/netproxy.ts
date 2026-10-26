import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { logger } from '../util/log.js';

const log = logger('netproxy');

/**
 * The network door of the sandbox (after Codex's network proxy): sandboxed commands may only
 * connect to this local HTTP proxy, and it lets through only hosts on the allowlist. HTTPS goes
 * through CONNECT tunnels (no interception), plain HTTP is forwarded. Local and private addresses
 * are refused unless listed explicitly, also when a listed name resolves to one.
 *
 * Patterns: "example.com" (exactly), "*.example.com" (subdomains only), "**.example.com" (the
 * domain and its subdomains). "*" alone is not accepted. Deny patterns win over allow patterns.
 */
export interface DomainPolicy {
  allow: string[];
  deny?: string[];
}

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase().trim().replace(/\.$/, '');
  if (!p || p === '*' || p === '**') return false;
  if (p.startsWith('**.')) return h === p.slice(3) || h.endsWith(p.slice(2));
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h !== p.slice(2);
  return h === p;
}

export function hostAllowed(host: string, policy: DomainPolicy): { ok: boolean; reason?: string } {
  if ((policy.deny ?? []).some((p) => hostMatches(host, p))) return { ok: false, reason: `${host} is on the deny list` };
  if (policy.allow.some((p) => hostMatches(host, p))) return { ok: true };
  return { ok: false, reason: `${host} is not on the network allowlist (terminal.sandbox.allowDomains)` };
}

/** Loopback, private, link-local and unique-local addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function checkTarget(host: string, policy: DomainPolicy): Promise<string | undefined> {
  const verdict = hostAllowed(host, policy);
  if (!verdict.ok) return verdict.reason;
  const explicitlyLocal = policy.allow.some((p) => !p.includes('*') && p.toLowerCase() === host.toLowerCase());
  if (explicitlyLocal) return undefined;
  const addrs = isIP(host) ? [host] : await lookup(host, { all: true }).then((r) => r.map((a) => a.address)).catch(() => [] as string[]);
  if (addrs.some(isPrivateAddress)) return `${host} resolves to a local or private address (list it exactly to allow it)`;
  return undefined;
}

/** The machine's own proxy for `host` — never for local addresses or what NO_PROXY exempts. */
function upstreamProxy(host = ''): URL | undefined {
  const h = host.toLowerCase();
  if (h === 'localhost' || (isIP(h) && isPrivateAddress(h))) return undefined;
  const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (noProxy.some((n) => n === '*' || h === n.replace(/^\./, '') || h.endsWith(n.startsWith('.') ? n : `.${n}`))) return undefined;
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  try {
    return raw ? new URL(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** Open a TCP tunnel to host:port, through the machine's own proxy when there is one. */
function openTunnel(host: string, port: number): Promise<Socket> {
  const up = upstreamProxy(host);
  return new Promise((resolve, reject) => {
    if (!up) {
      const s = connect(port, host, () => resolve(s));
      s.once('error', reject);
      return;
    }
    const auth = up.username ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`).toString('base64')}` } : {};
    const req = httpRequest({ host: up.hostname, port: Number(up.port) || 80, method: 'CONNECT', path: `${host}:${port}`, headers: { host: `${host}:${port}`, ...auth } });
    req.once('connect', (res, socket) => (res.statusCode === 200 ? resolve(socket) : (socket.destroy(), reject(new Error(`upstream proxy answered ${res.statusCode}`)))));
    req.once('error', reject);
    req.end();
  });
}

export class NetworkProxy {
  private server?: Server;
  port = 0;
  /** recent decisions, newest last (for diagnostics) */
  readonly log: { host: string; allowed: boolean; reason?: string; at: number }[] = [];

  constructor(private policy: () => DomainPolicy) {}

  private note(host: string, allowed: boolean, reason?: string): void {
    this.log.push({ host, allowed, reason, at: Date.now() });
    if (this.log.length > 200) this.log.shift();
    if (!allowed) log.info(`blocked ${host}: ${reason}`);
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = createServer((req, res) => void this.forward(req, res));
    server.on('clientError', (_e, socket) => socket.destroy());
    server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => void this.tunnel(req, client, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    server.unref();
    return this.port;
  }

  private async tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    // a client that hangs up early must never take the agent down
    client.on('error', () => client.destroy());
    const [host = '', portStr = '443'] = (req.url ?? '').replace(/^\[|\](?=:)/g, '').split(/:(?=\d+$)/);
    const why = await checkTarget(host, this.policy());
    this.note(host, !why, why);
    if (why) {
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nx-kronos-blocked: 1\r\n\r\nKronos sandbox: ${why}\n`);
      return;
    }
    try {
      const upstream = await openTunnel(host, Number(portStr));
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client).pipe(upstream);
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    } catch (e) {
      client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${(e as Error).message}\n`);
    }
  }

  private async forward(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('Kronos sandbox proxy: absolute URL expected\n');
      return;
    }
    const why = target.protocol === 'http:' ? await checkTarget(target.hostname, this.policy()) : `unsupported scheme ${target.protocol}`;
    this.note(target.hostname, !why, why);
    if (why) {
      res.writeHead(403, { 'content-type': 'text/plain', 'x-kronos-blocked': '1' }).end(`Kronos sandbox: ${why}\n`);
      return;
    }
    const up = upstreamProxy(target.hostname);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const out = httpRequest(
      up ? { host: up.hostname, port: Number(up.port) || 80, path: target.href, method: req.method, headers } : { host: target.hostname, port: Number(target.port) || 80, path: `${target.pathname}${target.search}`, method: req.method, headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    out.on('error', (e) => res.writeHead(502).end(`${e.message}\n`));
    req.pipe(out);
  }

  /** Environment that points common clients (curl, git, npm, pip, cargo, go) at the proxy. */
  env(): Record<string, string> {
    const url = `http://127.0.0.1:${this.port}`;
    return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, ALL_PROXY: url, all_proxy: url, NO_PROXY: '', no_proxy: '' };
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = undefined;
  }
}
