/**
 * Runs one Kronos turn on the embedded engine and translates the engine's live events into Kronos
 * agent events, so every Kronos surface (desktop, web, messaging) renders it exactly like a native
 * run: streamed text and thinking, tool calls and results, permission prompts, usage, messages.
 *
 * Event mapping (engine → Kronos):
 *   message.part.delta (text / reasoning)        → text_delta / thinking_delta
 *   message.part.updated  tool pending           → tool_call_start
 *                          tool running (input)   → tool_call
 *                          tool completed / error → tool_result
 *                          step-finish            → usage, then the step's assistant + tool messages
 *   permission.asked                              → Kronos permission prompt → reply
 *   session.error / session.idle                  → error / end of the turn
 */
import { addUsage, emptyUsage, type AgentEvent, type FilePart, type ImagePart, type Message, type Part, type PermissionDecision, type PermissionRequest, type StopReason, type ToolRisk, type Usage } from '../types.js';
import { newId } from '../util/misc.js';
import { logger } from '../util/log.js';
import { EngineError, type EngineClient, type EngineEvent, type EngineModelRef, type EnginePromptPart } from './client.js';

const log = logger('engine');

export interface EngineTurnOptions {
  client: EngineClient;
  runId: string;
  /** Kronos model ref recorded on assistant messages */
  modelRef: string;
  model: EngineModelRef;
  contextWindow: number;
  /** engine session that continues this Kronos conversation, if one exists */
  engineSessionId?: string;
  onEngineSession(id: string): void;
  title?: string;
  text: string;
  images?: ImagePart[];
  files?: FilePart[];
  /** extra system instructions (identity, user instructions) */
  system?: string;
  /** engine agent to run the turn with (e.g. "plan": read-only) */
  agent?: string;
  signal: AbortSignal;
  emit(e: AgentEvent): void;
  /** a finished assistant or tool message: persist and show it */
  onMessage(m: Message): void;
  askPermission(req: Omit<PermissionRequest, 'requestId' | 'sessionId'>): Promise<PermissionDecision>;
}

export interface EngineTurnResult {
  text: string;
  usage: Usage;
  stopReason: StopReason;
  error?: string;
  toolCalls: number;
  /** title the engine gave the conversation, when it produced a real one */
  engineTitle?: string;
}

interface ToolState {
  partId: string;
  name: string;
  input: Record<string, unknown>;
  started: boolean;
  called: boolean;
  done: boolean;
  output: string;
  isError: boolean;
}

interface StepState {
  order: { kind: 'text' | 'reasoning' | 'tool'; id: string }[];
  text: Map<string, string>;
  reasoning: Map<string, string>;
  tools: Map<string, ToolState>;
  flushed: boolean;
}

/** Engine tool names shown under the Kronos name the UI already knows, where the input matches. */
const TOOL_NAMES: Record<string, string> = { bash: 'shell' };

function toolsetOf(tool: string): string {
  if (tool === 'bash') return 'shell';
  if (['read', 'write', 'edit', 'list', 'glob', 'grep', 'patch', 'multiedit'].includes(tool)) return 'files';
  if (['webfetch', 'websearch'].includes(tool)) return 'web';
  if (tool === 'todowrite' || tool === 'todoread') return 'todo';
  if (tool === 'task') return 'delegate';
  if (tool === 'skill') return 'skills';
  return 'engine';
}

function riskOf(permission: string): ToolRisk {
  if (permission === 'bash') return 'execute' as ToolRisk;
  if (['edit', 'write', 'patch', 'multiedit'].includes(permission)) return 'write' as ToolRisk;
  return 'read' as ToolRisk;
}

function summarize(tool: string, input: Record<string, unknown>, title?: string): string {
  if (title) return title;
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const v = pick('description') || pick('command') || pick('filePath') || pick('path') || pick('pattern') || pick('url');
  return v ? `${tool}: ${v}`.slice(0, 160) : tool;
}

function describeError(err: unknown): string {
  const e = err as { name?: string; data?: { message?: string; statusCode?: number } } | undefined;
  const msg = e?.data?.message ?? (e as { message?: string })?.message ?? '';
  if (e?.name === 'ProviderAuthError') return `The model service rejected the request: ${msg || 'sign-in required'}.`;
  if (e?.name === 'APIError') return `The model service returned an error${e.data?.statusCode ? ` (${e.data.statusCode})` : ''}: ${msg}`;
  if (e?.name === 'ContextOverflowError') return 'The conversation no longer fits in the model\'s context window. Start a new chat or compact this one.';
  return msg || e?.name || 'The engine reported an error.';
}

function promptParts(text: string, images: ImagePart[] = [], files: FilePart[] = []): EnginePromptPart[] {
  let body = text;
  const parts: EnginePromptPart[] = [];
  for (const f of files) {
    if (f.path) parts.push({ type: 'file', mime: f.mediaType || 'text/plain', url: `file://${f.path}`, filename: f.name });
    else if (f.text) body += `\n\n<attachment name="${f.name}">\n${f.text}\n</attachment>`;
  }
  for (const img of images) parts.push({ type: 'file', mime: img.mediaType, url: `data:${img.mediaType};base64,${img.data}`, filename: img.name ?? 'image' });
  return [{ type: 'text', text: body || ' ' }, ...parts];
}

export async function runEngineTurn(o: EngineTurnOptions): Promise<EngineTurnResult> {
  const { client, runId } = o;
  const emit = o.emit;

  // continue the engine session behind this conversation, or start one
  let sid = o.engineSessionId;
  if (sid && !(await client.getSession(sid))) sid = undefined;
  if (!sid) {
    sid = (await client.createSession(o.title)).id;
    o.onEngineSession(sid);
  }
  const sessionId = sid;

  const roles = new Map<string, string>();
  const partTypes = new Map<string, string>();
  const emitted = new Map<string, number>(); // streamed length per text / reasoning part
  const steps = new Map<string, StepState>();
  const stepOrder: string[] = [];
  let usage = emptyUsage();
  let error: string | undefined;
  let toolCalls = 0;
  let aborted = false;
  let active = false;
  let lastText = '';

  let settled = false;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => (resolveFinished = r));
  const finish = () => {
    settled = true;
    resolveFinished();
  };

  const step = (messageId: string): StepState => {
    let s = steps.get(messageId);
    if (!s) {
      s = { order: [], text: new Map(), reasoning: new Map(), tools: new Map(), flushed: false };
      steps.set(messageId, s);
      stepOrder.push(messageId);
    }
    return s;
  };
  const addOrder = (s: StepState, kind: 'text' | 'reasoning' | 'tool', id: string) => {
    if (!s.order.some((x) => x.id === id)) s.order.push({ kind, id });
  };

  /** stream whatever part of a text / reasoning part the UI has not seen yet */
  const streamTo = (partId: string, kind: 'text' | 'reasoning', full: string) => {
    const seen = emitted.get(partId) ?? 0;
    if (full.length <= seen) return;
    const chunk = full.slice(seen);
    emitted.set(partId, full.length);
    emit(kind === 'text' ? { type: 'text_delta', runId, text: chunk } : { type: 'thinking_delta', runId, text: chunk });
  };

  const flush = (messageId: string) => {
    const s = steps.get(messageId);
    if (!s || s.flushed) return;
    s.flushed = true;
    const parts: Part[] = [];
    const thinking = [...s.reasoning.values()].join('').trim();
    if (thinking) parts.push({ type: 'thinking', text: thinking });
    const results: Part[] = [];
    let text = '';
    for (const item of s.order) {
      if (item.kind === 'text') {
        const t = s.text.get(item.id) ?? '';
        if (t) {
          parts.push({ type: 'text', text: t });
          text += t;
        }
      } else if (item.kind === 'tool') {
        const t = s.tools.get(item.id);
        if (!t) continue;
        parts.push({ type: 'tool_call', id: item.id, name: t.name, input: t.input });
        results.push({ type: 'tool_result', toolCallId: item.id, toolName: t.name, content: t.done ? t.output : 'Stopped before it finished.', isError: t.done ? t.isError : true });
      }
    }
    if (text.trim()) lastText = text;
    if (!parts.length) return;
    o.onMessage({ id: newId('m_'), role: 'assistant', parts, createdAt: Date.now(), model: o.modelRef });
    if (results.length) o.onMessage({ id: newId('m_'), role: 'tool', parts: results, createdAt: Date.now() });
  };

  const onTool = (part: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const s = step(part.messageID);
    const state = part.state ?? {};
    const id: string = part.callID || part.id;
    addOrder(s, 'tool', id);
    let t = s.tools.get(id);
    if (!t) {
      t = { partId: part.id, name: TOOL_NAMES[part.tool] ?? part.tool, input: {}, started: false, called: false, done: false, output: '', isError: false };
      s.tools.set(id, t);
    }
    if (!t.started) {
      t.started = true;
      emit({ type: 'tool_call_start', runId, id, name: t.name });
    }
    if (state.input && Object.keys(state.input).length) t.input = state.input;
    const settled = state.status === 'completed' || state.status === 'error';
    if (!t.called && (settled || (state.status === 'running' && Object.keys(t.input).length))) {
      t.called = true;
      emit({ type: 'tool_call', runId, id, name: t.name, input: t.input, summary: summarize(part.tool, t.input, state.title), toolset: toolsetOf(part.tool) });
    }
    if (settled && !t.done) {
      t.done = true;
      t.isError = state.status === 'error';
      t.output = String(t.isError ? (state.error ?? 'failed') : (state.output ?? ''));
      toolCalls += 1;
      const started = state.time?.start ?? 0;
      const ended = state.time?.end ?? started;
      emit({ type: 'tool_result', runId, id, name: t.name, content: t.output, isError: t.isError, durationMs: Math.max(0, ended - started) });
    }
  };

  const onPermission = async (p: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const patterns: string[] = p.patterns ?? [];
    let decision: PermissionDecision;
    try {
      decision = await o.askPermission({
        toolCallId: p.tool?.callID ?? '',
        toolName: TOOL_NAMES[p.permission] ?? p.permission,
        input: { ...(p.metadata ?? {}), patterns },
        summary: `${p.permission}: ${patterns.join(' ') || 'action'}`.slice(0, 200),
        risk: riskOf(p.permission),
        reason: `The agent wants to use ${p.permission}${patterns.length ? ` on ${patterns.join(', ')}` : ''}.`,
      });
    } catch {
      decision = { decision: 'deny', feedback: 'interrupted' };
    }
    const reply = decision.decision === 'deny' ? 'reject' : decision.decision === 'allow' ? 'once' : 'always';
    const message = decision.decision === 'deny' ? decision.feedback : undefined;
    await client.replyPermission(p.id, reply, message).catch((e) => log.warn('permission reply failed', e));
  };

  const handle = (ev: EngineEvent) => {
    const p = ev.properties ?? {};
    const evSession = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID;
    if (evSession !== sessionId) return;
    switch (ev.type) {
      case 'message.updated': {
        roles.set(p.info.id, p.info.role);
        if (p.info.role === 'assistant') {
          active = true;
          step(p.info.id);
          const err = p.info.error;
          if (err && err.name !== 'MessageAbortedError') error = describeError(err);
        }
        break;
      }
      case 'message.part.updated': {
        const part = p.part;
        partTypes.set(part.id, part.type);
        if (roles.get(part.messageID) !== 'assistant') break;
        const s = step(part.messageID);
        if (part.type === 'text') {
          s.text.set(part.id, part.text ?? '');
          addOrder(s, 'text', part.id);
          streamTo(part.id, 'text', part.text ?? '');
        } else if (part.type === 'reasoning') {
          s.reasoning.set(part.id, part.text ?? '');
          addOrder(s, 'reasoning', part.id);
          streamTo(part.id, 'reasoning', part.text ?? '');
        } else if (part.type === 'tool') {
          onTool(part);
        } else if (part.type === 'step-finish') {
          const t = part.tokens ?? {};
          const stepUsage: Usage = {
            inputTokens: Number(t.input) || 0,
            outputTokens: Number(t.output) || 0,
            reasoningTokens: Number(t.reasoning) || 0,
            cacheReadTokens: Number(t.cache?.read) || 0,
            cacheWriteTokens: Number(t.cache?.write) || 0,
            costUsd: Number(part.cost) || 0,
          };
          usage = addUsage(usage, stepUsage);
          emit({ type: 'usage', runId, usage: stepUsage, total: usage, contextTokens: stepUsage.inputTokens + stepUsage.cacheReadTokens, contextWindow: o.contextWindow });
          flush(part.messageID);
        }
        break;
      }
      case 'message.part.delta': {
        if (p.field !== 'text' || roles.get(p.messageID) !== 'assistant') break;
        const type = partTypes.get(p.partID);
        if (type !== 'text' && type !== 'reasoning') break;
        const s = step(p.messageID);
        const map = type === 'text' ? s.text : s.reasoning;
        const full = (map.get(p.partID) ?? '') + String(p.delta ?? '');
        map.set(p.partID, full);
        addOrder(s, type, p.partID);
        streamTo(p.partID, type, full);
        break;
      }
      case 'permission.asked':
        void onPermission(p);
        break;
      case 'question.asked':
        emit({ type: 'notice', runId, level: 'info', text: 'The agent asked a multiple-choice question; it continues without an answer.' });
        void client.rejectQuestion(p.id);
        break;
      case 'session.error':
        if (p.error && p.error.name !== 'MessageAbortedError') error = describeError(p.error);
        break;
      case 'session.status':
        if (p.status?.type === 'busy') active = true;
        break;
      case 'session.idle':
        if (active || error) finish();
        break;
      default:
        break;
    }
  };

  const streamCtl = new AbortController();
  const onAbort = () => {
    aborted = true;
    void client.abort(sessionId);
    // give the engine a moment to settle the turn, then stop listening regardless
    setTimeout(finish, 8000).unref?.();
  };
  if (o.signal.aborted) onAbort();
  else o.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const { closed } = await client.subscribe(handle, streamCtl.signal);
    void closed.then(() => {
      // only a stream that ends before the turn did means the engine went away (we close it ourselves after)
      if (!settled && !aborted) error ??= 'The Kronos engine stopped unexpectedly.';
      finish();
    });
    if (!aborted) {
      await client.promptAsync(sessionId, {
        model: o.model,
        parts: promptParts(o.text, o.images, o.files),
        ...(o.system ? { system: o.system } : {}),
        ...(o.agent ? { agent: o.agent } : {}),
      });
    }
    await finished;
  } catch (e) {
    if ((e as Error).name !== 'AbortError') error = e instanceof EngineError ? e.message : `The Kronos engine failed: ${(e as Error).message}`;
  } finally {
    o.signal.removeEventListener('abort', onAbort);
    streamCtl.abort();
  }

  // anything the engine did not close with a step-finish (abort, error) still becomes history
  for (const id of stepOrder) flush(id);

  let engineTitle: string | undefined;
  try {
    const info = await client.getSession(sessionId);
    if (info?.title && !/^new session/i.test(info.title) && info.title !== o.title) engineTitle = info.title;
  } catch {
    /* title is optional */
  }

  const stopReason: StopReason = aborted ? 'interrupted' : error ? ('error' as StopReason) : 'end_turn';
  return { text: lastText, usage, stopReason, error: aborted ? undefined : error, toolCalls, engineTitle };
}
