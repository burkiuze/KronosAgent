/** REST + WebSocket client for the Kronos gateway. */

const TOKEN_KEY = 'kronos.token';

function readToken(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      /* storage unavailable */
    }
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    return fromUrl;
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

const desktop = (window as unknown as { kronosDesktop?: { token?: string; baseUrl?: string } }).kronosDesktop;
export const token = desktop?.token ?? readToken();
export const baseUrl = desktop?.baseUrl ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers, body });
  const ctype = res.headers.get('content-type') ?? '';
  const data = ctype.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? String(data));
  return data as T;
}

export const get = <T>(p: string) => api<T>(p);
export const post = <T>(p: string, json?: unknown) => api<T>(p, { method: 'POST', json: json ?? {} });
export const put = <T>(p: string, json?: unknown) => api<T>(p, { method: 'PUT', json: json ?? {} });
export const patch = <T>(p: string, json?: unknown) => api<T>(p, { method: 'PATCH', json: json ?? {} });
export const del = <T>(p: string) => api<T>(p, { method: 'DELETE' });

export function fileUrl(path: string, opts: { download?: boolean } = {}): string {
  const q = new URLSearchParams({ path, raw: '1' });
  if (opts.download) q.set('download', '1');
  if (token) q.set('token', token);
  return `${baseUrl}/api/files/read?${q}`;
}

export function artifactUrl(id: string, download = false): string {
  const q = new URLSearchParams();
  if (download) q.set('download', '1');
  if (token) q.set('token', token);
  return `${baseUrl}/api/artifacts/${id}/file?${q}`;
}

export function downloadUrl(path: string): string {
  const q = new URLSearchParams();
  if (token) q.set('token', token);
  return `${baseUrl}${path}${path.includes('?') ? '&' : '?'}${q}`;
}

export function wsUrl(path: string, params: Record<string, string> = {}): string {
  const base = baseUrl || window.location.origin;
  const u = new URL(path, base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (token) u.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

type Listener = (msg: Record<string, unknown>) => void;

/** Auto-reconnecting WebSocket with a small message bus. */
export class Socket {
  private ws?: WebSocket;
  private listeners = new Set<Listener>();
  private queue: string[] = [];
  private retry = 0;
  private subs = new Set<string>();
  connected = false;
  private statusListeners = new Set<(c: boolean) => void>();

  connect(): void {
    const ws = new WebSocket(wsUrl('/ws'));
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.statusListeners.forEach((fn) => fn(true));
      for (const s of this.subs) ws.send(JSON.stringify({ type: 'subscribe', sessionId: s }));
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.listeners.forEach((fn) => fn(msg));
    };
    ws.onclose = () => {
      this.connected = false;
      this.statusListeners.forEach((fn) => fn(false));
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: Record<string, unknown>): void {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }

  subscribe(sessionId: string): void {
    this.subs.add(sessionId);
    this.send({ type: 'subscribe', sessionId });
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: (c: boolean) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
}

export const socket = new Socket();
