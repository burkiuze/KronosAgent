/**
 * HTTP client for the embedded engine's local server (`serve`). The engine runs the agent: it owns
 * the model calls, tools, permissions and its own session history; Kronos is the shell around it.
 *
 * Only the small part of the server API Kronos needs is wrapped here: sessions, prompting, the live
 * event stream, permission / question replies, the connected models and one-shot completions.
 */
import { logger } from '../util/log.js';

const log = logger('engine');

export interface EngineModelRef {
  providerID: string;
  modelID: string;
}

/** An engine event as delivered on `/event` (Server-Sent Events). */
export interface EngineEvent {
  type: string;
  properties: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface EngineModel {
  providerID: string;
  providerName: string;
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  free: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

export interface EnginePromptPart {
  type: 'text' | 'file';
  text?: string;
  mime?: string;
  url?: string;
  filename?: string;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/** The engine's own provider id for its hosted service: models there are the "free" group in Kronos. */
export const ENGINE_HOSTED_PROVIDER = 'opencode';

export class EngineClient {
  constructor(
    readonly baseUrl: string,
    /** project directory the engine scopes sessions, tools and config to */
    readonly directory?: string,
  ) {}

  withDirectory(directory: string): EngineClient {
    return new EngineClient(this.baseUrl, directory);
  }

  private url(path: string): string {
    const u = new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    if (this.directory) u.searchParams.set('directory', this.directory);
    return u.toString();
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path.replace(/^\//, '')), {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new EngineError(`The Kronos engine is not reachable (${(e as Error).message}).`);
    }
    const text = await res.text();
    if (!res.ok) throw new EngineError(`engine ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async healthy(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await fetch(this.url('global/health'), { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // models

  /**
   * Models the user can run through the engine: the hosted service's free models, plus every model
   * of the other providers connected in the engine (keys or sign-ins the user added there).
   */
  async models(): Promise<EngineModel[]> {
    const r = await this.request<{ all: any[]; connected: string[] }>('GET', 'provider'); // eslint-disable-line @typescript-eslint/no-explicit-any
    const connected = new Set(r.connected ?? []);
    const out: EngineModel[] = [];
    for (const p of r.all ?? []) {
      if (!connected.has(p.id)) continue;
      for (const [id, m] of Object.entries<any>(p.models ?? {})) { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (m.status === 'deprecated') continue;
        const cost = m.cost ?? {};
        const free = Number(cost.input ?? 0) === 0 && Number(cost.output ?? 0) === 0;
        // the hosted service also lists paid models; without a balance only its free ones run
        if (p.id === ENGINE_HOSTED_PROVIDER && !free) continue;
        const input: string[] = m.modalities?.input ?? [];
        out.push({
          providerID: p.id,
          providerName: p.name ?? p.id,
          id,
          name: m.name ?? id,
          contextWindow: Number(m.limit?.context) || 128_000,
          maxOutput: Number(m.limit?.output) || 32_000,
          free,
          tools: m.tool_call !== false,
          vision: input.some((x) => /image/.test(x)) || m.attachment === true,
          reasoning: Boolean(m.reasoning),
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // sessions

  async createSession(title?: string): Promise<{ id: string }> {
    return this.request('POST', 'session', title ? { title } : {});
  }

  async getSession(id: string): Promise<{ id: string; title?: string } | undefined> {
    try {
      return await this.request('GET', `session/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof EngineError && (e.status === 404 || e.status === 400)) return undefined;
      throw e;
    }
  }

  async deleteSession(id: string): Promise<void> {
    await this.request('DELETE', `session/${encodeURIComponent(id)}`).catch((e) => log.debug('delete session failed', e));
  }

  /** Start a turn; returns at once — progress arrives on the event stream. */
  async promptAsync(sessionId: string, body: { model: EngineModelRef; parts: EnginePromptPart[]; system?: string; agent?: string }): Promise<void> {
    await this.request('POST', `session/${encodeURIComponent(sessionId)}/prompt_async`, body);
  }

  /** Run a turn and wait for its final message (used for one-shot completions). */
  async prompt(sessionId: string, body: { model: EngineModelRef; parts: EnginePromptPart[]; system?: string; tools?: Record<string, boolean> }, signal?: AbortSignal): Promise<{ info: any; parts: any[] }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.request('POST', `session/${encodeURIComponent(sessionId)}/message`, body, signal);
  }

  async abort(sessionId: string): Promise<void> {
    await this.request('POST', `session/${encodeURIComponent(sessionId)}/abort`).catch((e) => log.debug('abort failed', e));
  }

  async replyPermission(requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    await this.request('POST', `permission/${encodeURIComponent(requestId)}/reply`, message ? { reply, message } : { reply });
  }

  async rejectQuestion(requestId: string): Promise<void> {
    await this.request('POST', `question/${encodeURIComponent(requestId)}/reject`).catch((e) => log.debug('question reject failed', e));
  }

  async toolIds(): Promise<string[]> {
    try {
      return await this.request<string[]>('GET', 'experimental/tool/ids');
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------------------------
  // events

  /**
   * Subscribe to the live event stream. Resolves once the server confirmed the subscription
   * (`server.connected`), so a prompt sent afterwards cannot miss its first events.
   */
  async subscribe(onEvent: (e: EngineEvent) => void, signal: AbortSignal): Promise<{ closed: Promise<void> }> {
    let res: Response;
    try {
      res = await fetch(this.url('event'), { signal, headers: { accept: 'text/event-stream' } });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new EngineError(`The Kronos engine is not reachable (${(e as Error).message}).`);
    }
    if (!res.ok || !res.body) throw new EngineError(`engine event stream failed (${res.status})`, res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let ready!: () => void;
    const connected = new Promise<void>((r) => (ready = r));
    const closed = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const data = chunk
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            let ev: EngineEvent;
            try {
              ev = JSON.parse(data);
            } catch {
              continue;
            }
            if (ev.type === 'server.connected') ready();
            try {
              onEvent(ev);
            } catch (e) {
              log.warn('engine event handler failed', e);
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') log.debug('engine event stream ended', e);
      } finally {
        ready();
      }
    })();
    // servers that do not announce the subscription: give the stream a moment, then go on
    await Promise.race([connected, new Promise((r) => setTimeout(r, 1500))]);
    return { closed };
  }
}
