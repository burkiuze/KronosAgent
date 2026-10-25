import type { AgentEvent, ClarifyRequest, FilePart, ImagePart, Kronos, PermissionDecision, PermissionMode, PermissionRequest, RuntimeEvent } from '@kronos/core';
import { newId, errorMessage, logger } from '@kronos/core';

const log = logger('hub');

export interface HubClient {
  id: string;
  send(msg: unknown): void;
  subscriptions: Set<string>;
}

export interface ChatInput {
  sessionId?: string;
  text: string;
  images?: ImagePart[];
  files?: FilePart[];
  model?: string;
  mode?: PermissionMode;
  cwd?: string;
  title?: string;
  source?: string;
  /** interrupt the current run instead of queueing */
  interrupt?: boolean;
  /** called with the session id before the run starts (subscribe the caller) */
  onSession?: (sessionId: string) => void;
}

interface Queued extends ChatInput {
  id: string;
  sessionId: string;
}

export interface RunningInfo {
  sessionId: string;
  title: string;
  startedAt: number;
  runId: string;
  source: string;
}

/** Events everyone receives (sidebar, status bar, notifications) even without subscribing. */
const GLOBAL_EVENTS = new Set<AgentEvent['type']>(['run_start', 'run_end', 'title', 'permission_request', 'permission_resolved', 'clarify_request', 'clarify_resolved', 'subagent', 'artifact']);

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Bridges live agents and connected UI clients: starts runs, queues follow-ups,
 * streams events, and routes permission / clarification answers back to agents.
 */
export class Hub {
  readonly clients = new Map<string, HubClient>();
  private queues = new Map<string, Queued[]>();
  private running = new Map<string, RunningInfo>();
  private pendingPerms = new Map<string, PermissionRequest>();
  private pendingAsks = new Map<string, ClarifyRequest>();
  private off?: () => void;
  private rt!: Kronos;

  constructor(rt: Kronos) {
    this.attach(rt);
  }

  attach(rt: Kronos): void {
    this.off?.();
    this.rt = rt;
    this.off = rt.events.on((e) => this.onRuntimeEvent(e));
  }

  get runtime(): Kronos {
    return this.rt;
  }

  addClient(c: HubClient): void {
    this.clients.set(c.id, c);
  }

  removeClient(id: string): void {
    this.clients.delete(id);
  }

  broadcast(msg: unknown, filter?: (c: HubClient) => boolean): void {
    for (const c of this.clients.values()) {
      if (filter && !filter(c)) continue;
      try {
        c.send(msg);
      } catch (e) {
        log.debug('send failed', e);
      }
    }
  }

  private onRuntimeEvent(e: RuntimeEvent): void {
    switch (e.type) {
      case 'agent': {
        const ev = e.event;
        if (ev.type === 'run_start') {
          const s = this.rt.sessions.get(e.sessionId);
          this.running.set(e.sessionId, { sessionId: e.sessionId, title: s?.title ?? '', startedAt: Date.now(), runId: ev.runId, source: s?.source ?? '' });
          this.broadcastStatus();
        }
        if (ev.type === 'run_end') {
          this.running.delete(e.sessionId);
          this.broadcastStatus();
        }
        if (ev.type === 'permission_request') this.pendingPerms.set(ev.request.requestId, ev.request);
        if (ev.type === 'permission_resolved') this.pendingPerms.delete(ev.requestId);
        if (ev.type === 'clarify_request') this.pendingAsks.set(ev.request.requestId, ev.request);
        if (ev.type === 'clarify_resolved') this.pendingAsks.delete(ev.requestId);
        const global = GLOBAL_EVENTS.has(ev.type);
        this.broadcast({ type: 'event', sessionId: e.sessionId, event: ev }, (c) => global || c.subscriptions.has(e.sessionId) || c.subscriptions.has('*'));
        break;
      }
      case 'session_updated':
        this.broadcast({ type: 'session_updated', sessionId: e.sessionId });
        break;
      case 'config_changed':
        this.broadcast({ type: 'config_changed' });
        break;
      case 'cron':
        this.broadcast({ type: 'cron', kind: e.kind, job: e.job });
        break;
      case 'artifact_added':
        this.broadcast({ type: 'artifact_added', artifactId: e.artifactId });
        break;
    }
  }

  runningList(): RunningInfo[] {
    return [...this.running.values()];
  }

  queueOf(sessionId: string): { id: string; text: string }[] {
    return (this.queues.get(sessionId) ?? []).map((q) => ({ id: q.id, text: q.text }));
  }

  broadcastStatus(): void {
    this.broadcast({ type: 'status', running: this.runningList() });
  }

  private uiPermission = (): Promise<PermissionDecision> =>
    new Promise((resolve) => setTimeout(() => resolve({ decision: 'deny', feedback: 'No answer within 30 minutes.' }), APPROVAL_TIMEOUT_MS).unref());

  private uiClarify = (): Promise<string> => new Promise((resolve) => setTimeout(() => resolve(''), APPROVAL_TIMEOUT_MS).unref());

  /** Start (or queue) a message for a session; creates the session when needed. */
  async chat(input: ChatInput): Promise<{ sessionId: string; queued: boolean }> {
    const rt = this.rt;
    let sessionId = input.sessionId;
    if (!sessionId || !rt.sessions.get(sessionId)) {
      const s = rt.createSession({
        id: sessionId,
        source: input.source ?? 'desktop',
        cwd: input.cwd,
        title: input.title,
        model: input.model ? rt.providers.resolve(input.model).ref : '',
        mode: input.mode ?? rt.config.safety.mode,
      });
      sessionId = s.id;
    }
    input.onSession?.(sessionId);
    const agent = rt.agent(sessionId, { surface: (input.source ?? 'desktop').split(':')[0], onPermission: this.uiPermission, onClarify: this.uiClarify });
    if (input.mode && input.mode !== agent.mode) agent.setMode(input.mode);
    if (input.model) agent.setModel(input.model);
    const item: Queued = { ...input, id: newId('q_'), sessionId };
    if (agent.isRunning) {
      if (input.interrupt) agent.interrupt();
      const q = this.queues.get(sessionId) ?? [];
      q.push(item);
      this.queues.set(sessionId, q);
      this.broadcast({ type: 'queued', sessionId, queue: this.queueOf(sessionId) });
      return { sessionId, queued: true };
    }
    void this.process(item);
    return { sessionId, queued: false };
  }

  private async process(item: Queued): Promise<void> {
    const rt = this.rt;
    let next: Queued | undefined = item;
    while (next) {
      const current: Queued = next;
      try {
        const agent = rt.agent(current.sessionId, { onPermission: this.uiPermission, onClarify: this.uiClarify });
        const expanded = await rt.expandInput(current.text, agent.session.cwd);
        await agent.run(
          {
            text: expanded.text,
            images: [...(current.images ?? []), ...(expanded.images ?? [])],
            files: [...(current.files ?? []), ...(expanded.files ?? [])],
            meta: expanded.meta,
          },
          { model: current.model },
        );
      } catch (e) {
        this.broadcast({ type: 'error', sessionId: current.sessionId, message: errorMessage(e) });
      }
      const q = this.queues.get(current.sessionId);
      next = q?.shift();
      if (q && !q.length) this.queues.delete(current.sessionId);
      if (next) this.broadcast({ type: 'queued', sessionId: current.sessionId, queue: this.queueOf(current.sessionId) });
    }
  }

  stop(sessionId: string): void {
    this.queues.delete(sessionId);
    this.rt.liveAgents().find((a) => a.id === sessionId)?.interrupt();
    this.broadcast({ type: 'queued', sessionId, queue: [] });
  }

  removeQueued(sessionId: string, id: string): void {
    const q = this.queues.get(sessionId);
    if (!q) return;
    this.queues.set(sessionId, q.filter((x) => x.id !== id));
    this.broadcast({ type: 'queued', sessionId, queue: this.queueOf(sessionId) });
  }

  respondPermission(sessionId: string, requestId: string, decision: PermissionDecision): boolean {
    for (const a of this.rt.liveAgents()) if (a.respondPermission(requestId, decision)) return true;
    void sessionId;
    return false;
  }

  respondClarify(sessionId: string, requestId: string, answer: string): boolean {
    for (const a of this.rt.liveAgents()) if (a.respondClarify(requestId, answer)) return true;
    void sessionId;
    return false;
  }

  /** Pending interactive requests (for clients that connect mid-run). */
  pending(): { permissions: PermissionRequest[]; clarify: ClarifyRequest[] } {
    return { permissions: [...this.pendingPerms.values()], clarify: [...this.pendingAsks.values()] };
  }
}
