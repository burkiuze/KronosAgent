import { useRef, useSyncExternalStore } from 'react';
import type { AgentEvent, ClarifyRequest, ImagePart, Message, PermissionRequest, RunningInfo, Session, Status, Todo, ToolMeta, Usage, FilePart, PermissionMode } from './types';
import { get, socket, del, patch, post } from './api';

export type View = 'chat' | 'skills' | 'messaging' | 'artifacts' | 'automations' | 'memory' | 'insights';

export interface ToolLive {
  id: string;
  name: string;
  summary?: string;
  input?: Record<string, unknown>;
  partialJson?: string;
  progress?: string;
  result?: { content: string; isError: boolean; durationMs: number; meta?: ToolMeta; images?: ImagePart[] };
}

export type LiveItem = { kind: 'thinking'; text: string } | { kind: 'text'; text: string } | { kind: 'tool'; id: string };

export interface SubagentLive {
  agentId: string;
  label: string;
  status: 'start' | 'running' | 'done' | 'error';
  detail?: string;
}

export interface ChatState {
  loaded: boolean;
  messages: Message[];
  live: LiveItem[];
  tools: Record<string, ToolLive>;
  pendingUser?: Message;
  todos: Todo[];
  queue: { id: string; text: string }[];
  running: boolean;
  runStartedAt?: number;
  context?: { tokens: number; window: number; percent: number };
  usage?: Usage;
  subagents: Record<string, SubagentLive>;
  notices: { id: string; level: 'info' | 'warn' | 'error'; text: string }[];
}

export interface Toast {
  id: string;
  text: string;
  kind: 'ok' | 'error' | 'info';
}

export interface AppState {
  connected: boolean;
  status?: Status;
  sessions: Session[];
  currentId?: string;
  view: View;
  chats: Record<string, ChatState>;
  running: RunningInfo[];
  permissions: PermissionRequest[];
  clarify: ClarifyRequest[];
  sidebarOpen: boolean;
  rightPanel: null | 'files' | 'terminal';
  settings: string | null;
  paletteOpen: boolean;
  profilesOpen: boolean;
  toasts: Toast[];
  groupByProject: boolean;
  autoSpeak: boolean;
  draftModel?: string;
  draftMode?: PermissionMode;
  configVersion: number;
}

function loadPref<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(`kronos.${key}`);
    return v === null ? def : (JSON.parse(v) as T);
  } catch {
    return def;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`kronos.${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

let state: AppState = {
  connected: false,
  sessions: [],
  view: 'chat',
  chats: {},
  running: [],
  permissions: [],
  clarify: [],
  sidebarOpen: loadPref('sidebarOpen', true),
  rightPanel: loadPref('rightPanel', null),
  settings: null,
  paletteOpen: false,
  profilesOpen: false,
  toasts: [],
  groupByProject: loadPref('groupByProject', false),
  autoSpeak: loadPref('autoSpeak', false),
  configVersion: 0,
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patchOrFn: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patchOrFn === 'function' ? patchOrFn(state) : patchOrFn;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Shallow equality for selector results (arrays element-wise, plain objects key-wise). */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => Object.is(x, (b as unknown[])[i]));
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Subscribe to a slice of the store. Selectors may derive new arrays/objects (filter, find…):
 * the previous value is reused while it is shallow-equal, so React never sees a fresh snapshot
 * for unchanged data.
 */
export function useStore<T>(selector: (s: AppState) => T): T {
  const last = useRef<{ value: T } | null>(null);
  return useSyncExternalStore(subscribe, () => {
    const next = selector(state);
    if (last.current && shallowEqual(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  });
}

const emptyChat = (): ChatState => ({ loaded: false, messages: [], live: [], tools: {}, todos: [], queue: [], running: false, subagents: {}, notices: [] });
const EMPTY_CHAT: ChatState = Object.freeze(emptyChat()) as ChatState;

export function chatOf(id: string | undefined): ChatState {
  return (id && state.chats[id]) || EMPTY_CHAT;
}

function updateChat(id: string, fn: (c: ChatState) => Partial<ChatState>): void {
  const cur = state.chats[id] ?? emptyChat();
  setState({ chats: { ...state.chats, [id]: { ...cur, ...fn(cur) } } });
}

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------

export function toast(text: string, kind: Toast['kind'] = 'ok'): void {
  const id = Math.random().toString(36).slice(2);
  setState((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3200);
}

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

let sessionsTimer: ReturnType<typeof setTimeout> | undefined;
export function refreshSessions(delay = 0): void {
  clearTimeout(sessionsTimer);
  sessionsTimer = setTimeout(async () => {
    try {
      const sessions = await get<Session[]>('/api/sessions');
      setState({ sessions });
    } catch {
      /* offline */
    }
  }, delay);
}

export async function refreshStatus(): Promise<void> {
  try {
    const status = await get<Status>('/api/status');
    const permissions = status.pending?.permissions ?? [];
    const clarify = status.pending?.clarify ?? [];
    setState({ status, running: status.running, permissions, clarify });
  } catch {
    /* offline */
  }
}

export async function loadSession(id: string): Promise<void> {
  try {
    const d = await get<{ session: Session; messages: Message[]; todos: Todo[]; running: boolean; queue: { id: string; text: string }[]; context: ChatState['context'] }>(`/api/sessions/${id}`);
    updateChat(id, (c) => ({
      loaded: true,
      messages: d.messages,
      todos: d.todos ?? [],
      running: d.running,
      queue: d.queue ?? [],
      context: d.context ?? c.context,
      usage: d.session.usage,
      live: d.running ? c.live : [],
      pendingUser: undefined,
    }));
    setState((s) => ({ sessions: s.sessions.some((x) => x.id === id) ? s.sessions.map((x) => (x.id === id ? { ...x, ...d.session } : x)) : [d.session, ...s.sessions] }));
  } catch (e) {
    toast(`Could not load session: ${(e as Error).message}`, 'error');
  }
}

export function openSession(id: string | undefined): void {
  setState({ currentId: id, view: 'chat' });
  if (id) {
    socket.subscribe(id);
    if (!state.chats[id]?.loaded) void loadSession(id);
  }
  try {
    const url = new URL(window.location.href);
    if (id) url.hash = `#/s/${id}`;
    else url.hash = '';
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* ignore */
  }
}

export function newChat(): void {
  setState({ currentId: undefined, view: 'chat' });
  window.history.replaceState({}, '', window.location.pathname);
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

let reqCounter = 0;
const pendingAcks = new Map<string, (sessionId: string) => void>();

export function sendMessage(text: string, opts: { images?: ImagePart[]; files?: FilePart[]; interrupt?: boolean } = {}): Promise<string> {
  const sessionId = state.currentId;
  const requestId = `req${++reqCounter}`;
  const optimistic: Message = {
    id: `pending-${requestId}`,
    role: 'user',
    parts: [{ type: 'text', text }, ...(opts.images ?? []), ...(opts.files ?? [])],
    createdAt: Date.now(),
  };
  if (sessionId) {
    const chat = chatOf(sessionId);
    if (!chat.running) updateChat(sessionId, () => ({ pendingUser: optimistic }));
  }
  socket.send({ type: 'chat', requestId, sessionId, text, images: opts.images, files: opts.files, model: sessionId ? undefined : state.draftModel, mode: sessionId ? undefined : state.draftMode, interrupt: opts.interrupt });
  return new Promise((resolve) => {
    pendingAcks.set(requestId, (sid) => {
      if (!sessionId) {
        updateChat(sid, (c) => ({ pendingUser: c.messages.some((m) => m.role === 'user') ? undefined : optimistic }));
        openSession(sid);
        void loadSession(sid);
        refreshSessions(100);
      }
      resolve(sid);
    });
  });
}

export function stopRun(sessionId: string): void {
  socket.send({ type: 'stop', sessionId });
}

export function answerPermission(req: PermissionRequest, decision: 'allow' | 'allow_session' | 'allow_always' | 'deny', feedback?: string): void {
  socket.send({ type: 'permission', sessionId: req.sessionId, requestId: req.requestId, decision, feedback });
  setState((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== req.requestId) }));
}

export function answerClarify(req: ClarifyRequest, answer: string): void {
  socket.send({ type: 'clarify', sessionId: req.sessionId, requestId: req.requestId, answer });
  setState((s) => ({ clarify: s.clarify.filter((p) => p.requestId !== req.requestId) }));
}

export async function setSessionMode(sessionId: string, mode: PermissionMode): Promise<void> {
  await patch(`/api/sessions/${sessionId}`, { mode });
  setState((s) => ({ sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, mode } : x)) }));
}

export async function setSessionModel(sessionId: string, model: string): Promise<void> {
  const s = await patch<Session>(`/api/sessions/${sessionId}`, { model });
  setState((st) => ({ sessions: st.sessions.map((x) => (x.id === sessionId ? { ...x, model: s.model } : x)) }));
}

export async function togglePin(s: Session): Promise<void> {
  await patch(`/api/sessions/${s.id}`, { pinned: !s.pinned });
  refreshSessions();
}

export async function renameSession(id: string, title: string): Promise<void> {
  await patch(`/api/sessions/${id}`, { title });
  refreshSessions();
}

export async function deleteSession(id: string): Promise<void> {
  await del(`/api/sessions/${id}`);
  if (state.currentId === id) newChat();
  refreshSessions();
}

export async function undoLast(id: string): Promise<void> {
  const r = await post<{ removed: number; restoredFiles: string[] }>(`/api/sessions/${id}/undo`);
  await loadSession(id);
  toast(r.removed ? `Undone${r.restoredFiles.length ? ` · ${r.restoredFiles.length} file(s) restored` : ''}` : 'Nothing to undo', 'info');
}

// ---------------------------------------------------------------------------
// event handling
// ---------------------------------------------------------------------------

let speakHook: ((text: string) => void) | undefined;
export function onFinalText(fn: (text: string) => void): void {
  speakHook = fn;
}

function handleAgentEvent(sessionId: string, e: AgentEvent): void {
  switch (e.type) {
    case 'run_start':
      updateChat(sessionId, () => ({ running: true, runStartedAt: Date.now(), live: [], subagents: {}, notices: [] }));
      setState((s) => ({ running: [...s.running.filter((r) => r.sessionId !== sessionId), { sessionId, title: '', startedAt: Date.now(), runId: e.runId, source: '' }] }));
      break;
    case 'turn_start':
      updateChat(sessionId, () => ({ live: [] }));
      break;
    case 'thinking_delta':
      updateChat(sessionId, (c) => {
        const live = [...c.live];
        const last = live[live.length - 1];
        if (last?.kind === 'thinking') live[live.length - 1] = { kind: 'thinking', text: last.text + e.text };
        else live.push({ kind: 'thinking', text: e.text });
        return { live };
      });
      break;
    case 'text_delta':
      updateChat(sessionId, (c) => {
        const live = [...c.live];
        const last = live[live.length - 1];
        if (last?.kind === 'text') live[live.length - 1] = { kind: 'text', text: last.text + e.text };
        else live.push({ kind: 'text', text: e.text });
        return { live };
      });
      break;
    case 'tool_call_start':
      updateChat(sessionId, (c) => ({ live: [...c.live, { kind: 'tool', id: e.id }], tools: { ...c.tools, [e.id]: { id: e.id, name: e.name } } }));
      break;
    case 'tool_call_delta':
      updateChat(sessionId, (c) => {
        const t = c.tools[e.id];
        if (!t) return {};
        return { tools: { ...c.tools, [e.id]: { ...t, partialJson: (t.partialJson ?? '') + e.partialJson } } };
      });
      break;
    case 'tool_call':
      updateChat(sessionId, (c) => ({ tools: { ...c.tools, [e.id]: { ...(c.tools[e.id] ?? { id: e.id, name: e.name }), name: e.name, summary: e.summary, input: e.input } } }));
      break;
    case 'tool_progress':
      updateChat(sessionId, (c) => {
        const t = c.tools[e.id];
        return t ? { tools: { ...c.tools, [e.id]: { ...t, progress: e.text } } } : {};
      });
      break;
    case 'tool_result':
      updateChat(sessionId, (c) => ({
        tools: { ...c.tools, [e.id]: { ...(c.tools[e.id] ?? { id: e.id, name: e.name }), result: { content: e.content, isError: e.isError, durationMs: e.durationMs, meta: e.meta, images: e.images } } },
      }));
      break;
    case 'message':
      updateChat(sessionId, (c) => {
        if (c.messages.some((m) => m.id === e.message.id)) return {};
        const patchState: Partial<ChatState> = { messages: [...c.messages, e.message] };
        if (e.message.role === 'user') patchState.pendingUser = undefined;
        if (e.message.role === 'assistant') patchState.live = [];
        return patchState;
      });
      break;
    case 'usage':
      updateChat(sessionId, () => ({ usage: e.total, context: { tokens: e.contextTokens, window: e.contextWindow, percent: Math.round((e.contextTokens / e.contextWindow) * 100) } }));
      break;
    case 'todos':
      updateChat(sessionId, () => ({ todos: e.todos }));
      break;
    case 'subagent':
      updateChat(sessionId, (c) => ({ subagents: { ...c.subagents, [e.agentId]: { agentId: e.agentId, label: e.label, status: e.status, detail: e.detail } } }));
      break;
    case 'notice':
      updateChat(sessionId, (c) => ({ notices: [...c.notices.slice(-4), { id: Math.random().toString(36).slice(2), level: e.level, text: e.text }] }));
      if (e.level === 'error') toast(e.text, 'error');
      break;
    case 'compaction':
      void loadSession(sessionId);
      break;
    case 'permission_request':
      setState((s) => ({ permissions: [...s.permissions.filter((p) => p.requestId !== e.request.requestId), e.request] }));
      notifyDesktop('Kronos needs approval', e.request.summary);
      break;
    case 'permission_resolved':
      setState((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== e.requestId) }));
      break;
    case 'clarify_request':
      setState((s) => ({ clarify: [...s.clarify.filter((p) => p.requestId !== e.request.requestId), e.request] }));
      notifyDesktop('Kronos has a question', e.request.question);
      break;
    case 'clarify_resolved':
      setState((s) => ({ clarify: s.clarify.filter((p) => p.requestId !== e.requestId) }));
      break;
    case 'title':
      setState((s) => ({ sessions: s.sessions.map((x) => (x.id === e.sessionId ? { ...x, title: e.title } : x)) }));
      break;
    case 'run_end':
      updateChat(sessionId, () => ({ running: false, runStartedAt: undefined }));
      setState((s) => ({ running: s.running.filter((r) => r.sessionId !== sessionId) }));
      if (state.chats[sessionId]?.loaded) void loadSession(sessionId);
      refreshSessions(300);
      if (state.currentId === sessionId && e.text && state.autoSpeak) speakHook?.(e.text);
      if (document.hidden && e.text) notifyDesktop('Kronos finished', e.text.slice(0, 140));
      break;
    default:
      break;
  }
}

function notifyDesktop(title: string, body: string): void {
  const d = (window as unknown as { kronosDesktop?: { notify?: (t: string, b: string) => void } }).kronosDesktop;
  if (d?.notify) return d.notify(title, body);
  if (!document.hidden) return;
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
  } catch {
    /* ignore */
  }
}

export function startRealtime(): void {
  socket.onStatus((connected) => {
    setState({ connected });
    if (connected) {
      void refreshStatus();
      refreshSessions();
      if (state.currentId) void loadSession(state.currentId);
    }
  });
  socket.on((msg) => {
    switch (msg.type) {
      case 'ready':
        setState({ running: (msg.running as RunningInfo[]) ?? [] });
        break;
      case 'chat_ack': {
        const fn = pendingAcks.get(String(msg.requestId));
        pendingAcks.delete(String(msg.requestId));
        fn?.(String(msg.sessionId));
        break;
      }
      case 'event':
        handleAgentEvent(String(msg.sessionId), msg.event as AgentEvent);
        break;
      case 'session_updated':
        refreshSessions(400);
        break;
      case 'queued':
        updateChat(String(msg.sessionId), () => ({ queue: (msg.queue as { id: string; text: string }[]) ?? [] }));
        break;
      case 'status':
        setState({ running: (msg.running as RunningInfo[]) ?? [] });
        break;
      case 'config_changed':
        setState((s) => ({ configVersion: s.configVersion + 1 }));
        void refreshStatus();
        break;
      case 'profile_changed':
        setState({ chats: {}, currentId: undefined });
        void refreshStatus();
        refreshSessions();
        toast(`Switched to profile ${String(msg.profile)}`);
        break;
      case 'error':
        toast(String(msg.message), 'error');
        break;
      default:
        break;
    }
  });
  socket.connect();
  const m = /#\/s\/([\w-]+)/.exec(window.location.hash);
  if (m) openSession(m[1]);
}
