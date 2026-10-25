import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

export interface Req {
  raw: IncomingMessage;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  body<T = unknown>(): Promise<T>;
  rawBody(): Promise<Buffer>;
}

export type Handler = (req: Req, res: ServerResponse) => Promise<unknown> | unknown;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 60 * 1024 * 1024;

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Minimal router: `GET /api/sessions/:id` style patterns, JSON in/out. */
export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/\/:([a-zA-Z_]+)(\*)?/g, (_, k: string, star?: string) => {
        keys.push(k);
        return star ? '/(.+)' : '/([^/]+)';
      })}/?$`,
    );
    this.routes.push({ method: method.toUpperCase(), re, keys, handler });
    return this;
  }
  get(p: string, h: Handler) {
    return this.on('GET', p, h);
  }
  post(p: string, h: Handler) {
    return this.on('POST', p, h);
  }
  put(p: string, h: Handler) {
    return this.on('PUT', p, h);
  }
  patch(p: string, h: Handler) {
    return this.on('PATCH', p, h);
  }
  delete(p: string, h: Handler) {
    return this.on('DELETE', p, h);
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
      return { route: r, params };
    }
    return null;
  }

  async handle(raw: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(raw.url ?? '/', 'http://localhost');
    const method = (raw.method ?? 'GET').toUpperCase();
    const found = this.match(method, url.pathname);
    if (!found) return false;
    let cached: Buffer | undefined;
    const rawBody = async () => (cached ??= await readBody(raw));
    const req: Req = {
      raw,
      method,
      path: url.pathname,
      query: url.searchParams,
      params: found.params,
      headers: raw.headers,
      rawBody,
      async body<T>() {
        const b = await rawBody();
        if (!b.length) return {} as T;
        try {
          return JSON.parse(b.toString('utf8')) as T;
        } catch {
          throw new HttpError(400, 'invalid JSON body');
        }
      },
    };
    try {
      const out = await found.route.handler(req, res);
      if (!res.writableEnded && !res.headersSent) sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: (e as Error).message });
      else res.end();
    }
    return true;
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json',
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function sendFile(res: ServerResponse, file: string, opts: { download?: boolean; cache?: boolean } = {}): void {
  const st = statSync(file);
  const headers: Record<string, string | number> = { 'content-type': mimeFor(file), 'content-length': st.size };
  if (opts.download) headers['content-disposition'] = `attachment; filename="${file.split(/[\\/]/).pop()?.replace(/"/g, '')}"`;
  headers['cache-control'] = opts.cache ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

/** Serve a built single-page app with index.html fallback. */
export function serveStatic(root: string, raw: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(raw.url ?? '/', 'http://localhost');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const full = resolve(root, rel);
  if (!full.startsWith(resolve(root) + sep) && full !== resolve(root)) return false;
  if (existsSync(full) && statSync(full).isFile()) {
    sendFile(res, full, { cache: rel.startsWith('assets') });
    return true;
  }
  const index = join(root, 'index.html');
  if (existsSync(index) && !rel.startsWith('api/') && !extname(rel)) {
    sendFile(res, index);
    return true;
  }
  return false;
}
