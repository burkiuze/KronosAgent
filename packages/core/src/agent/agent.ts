import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type {
  AgentEvent,
  ChatRequest,
  ClarifyRequest,
  Message,
  ModelInfo,
  Part,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  StopReason,
  TextPart,
  Todo,
  ToolCallPart,
  ToolResultPart,
  ToolSpec,
  Usage,
  UserInput,
} from '../types.js';
import { addUsage, emptyUsage, messageText } from '../types.js';
import type { Kronos } from '../runtime.js';
import type { SessionRecord } from '../sessions/store.js';
import type { ToolContext, ToolDefinition } from '../tools/types.js';
import { resolveRisk } from '../tools/types.js';
import type { AgentDefinition } from './definitions.js';
import { buildSystemPrompt, discoverContextFiles } from './prompt.js';
import { reviewAction } from '../safety/guardian.js';
import { deferredTools } from '../tools/toolsearch.js';
import { LEARNING_REVIEWER, hasLearningSignal } from './learning.js';
import { recapTranscript } from '../memory/recaps.js';
import { detectProjectChecks } from './checks.js';
import { TeamBoard } from './board.js';
import { LoopWatch } from './watchdog.js';
import { formatSyntaxProblems, syntaxProblems } from '../tools/diagnostics.js';
import { formatLspErrors } from '../tools/lsp.js';
import { describeArgs, exampleArgs, resolveToolName, suggestTools } from '../providers/toolcalls.js';
import { PermissionPolicy, primaryArg } from '../safety/permissions.js';
import { validateInput } from '../util/schema.js';
import { Emitter, errorMessage, isAbortError, mapLimit, newId, abortError } from '../util/misc.js';
import { estimateMessagesTokens, estimateTokens, redactSecrets, truncate, truncateMiddle } from '../util/text.js';
import { costOf } from '../providers/catalog.js';
import { NotConnectedError } from '../providers/errors.js';
import { logger } from '../util/log.js';

const log = logger('agent');

/** The expected arguments and an example call, so a model can correct a malformed call by itself. */
function usageHint(def: ToolDefinition): string {
  const args = describeArgs(def.parameters, 80);
  return `\nExpected arguments for ${def.name}:\n${args.map((a) => `- ${a}`).join('\n') || '- (none)'}\nExample: ${JSON.stringify({ name: def.name, arguments: exampleArgs(def.parameters) })}`;
}

/** A reply that ends by announcing an action instead of doing it (English and Turkish). */
const ANNOUNCED_ACTION =
  /(?:^|[.!?:\n]\s*)(?:(?:ok(?:ay)?|now|next|first|then|so),?\s+)?(?:let me|let's|i(?:'ll| will| am going to|'m going to| need to| should))\s+(?:now\s+|first\s+|then\s+)?(?:run|check|read|open|create|write|edit|update|modify|look|search|list|install|test|fix|implement|add|start|try|use|call|execute|inspect|examine|verify|make|change|apply|build|compile|grep|fetch|explore|review|find)\b[^.!?\n]{0,160}[.:…]?\s*$|\S+(?:acağım|eceğim)(?:\s+\S+){0,2}[.:…!]?\s*$/i;

/** The tool set of lean mode: enough to do real work, small enough for a small model to use well. */
const LEAN_TOOLS = new Set(['tool_search', 'repo_map', 'read_file', 'write_file', 'edit_file', 'shell', 'list_dir', 'grep', 'glob', 'todo_write', 'web_search', 'web_fetch', 'memory', 'ask_user', 'verify', 'exit_plan_mode']);

/** tools whose results get a syntax check of the files they changed */
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch']);

export interface AgentOptions {
  runtime: Kronos;
  session: SessionRecord;
  surface?: string;
  depth?: number;
  definition?: AgentDefinition;
  subagentContext?: string;
  onPermission?: (req: PermissionRequest) => Promise<PermissionDecision>;
  onClarify?: (req: ClarifyRequest) => Promise<string>;
  /** non-interactive runs: approve "ask" actions automatically (cron in yolo-ish modes) */
  autoApprove?: boolean;
  preloadSkills?: string[];
  toolFilter?: { only?: string[]; exclude?: string[] };
  /** members of a delegated team share a board (see team_board) */
  team?: { board: TeamBoard; member: string };
  /** tools only this agent has (e.g. the review_comment tool of a code reviewer) */
  extraTools?: ToolDefinition[];
}

export interface AgentRunOptions {
  model?: string;
  signal?: AbortSignal;
  maxIterations?: number;
}

export interface AgentRunResult {
  runId: string;
  text: string;
  stopReason: StopReason;
  usage: Usage;
  durationMs: number;
  error?: string;
  toolCalls: number;
}

export interface DelegateTask {
  task: string;
  label?: string;
  agent?: string;
  model?: string;
  toolsets?: string[];
}

export interface DelegateResult {
  label: string;
  ok: boolean;
  text: string;
  error?: string;
  sessionId: string;
  durationMs: number;
  usage: Usage;
}

export interface BackgroundAgent {
  id: string;
  label: string;
  sessionId: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: number;
  finishedAt?: number;
  /** final report of the latest task */
  result?: string;
  error?: string;
  /** results already handed to the parent */
  reported: boolean;
  child: Agent;
  done: Promise<void>;
  controller: AbortController;
}

function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * The Kronos agent loop: one instance per session. Streams model output, runs tools
 * (parallel where safe) behind the permission policy and hooks, checkpoints file edits,
 * compacts long histories, delegates to subagents and records usage.
 */
export class Agent {
  readonly events = new Emitter<AgentEvent>();
  session: SessionRecord;
  mode: PermissionMode;
  todos: Todo[] = [];
  private messages: Message[];
  private readonly rt: Kronos;
  private readonly policy: PermissionPolicy;
  private controller?: AbortController;
  private running = false;
  private codemasterActive = false;
  private currentRunId = '';
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();
  private pendingClarify = new Map<string, (a: string) => void>();
  private readFiles = new Set<string>();
  /** subagents started with agents(action: spawn), running while this agent keeps working */
  private bgAgents = new Map<string, BackgroundAgent>();
  private bgNudged = false;
  /** mtime/size of each file as this agent last read or wrote it (stale-write guard) */
  private fileStamps = new Map<string, { mtimeMs: number; size: number }>();
  private staleWarned = new Set<string>();
  /**
   * Full file reads whose content is still in the context, keyed by path + range. Bumping
   * `contextEpoch` (compaction, undo) invalidates them all, since earlier tool output is gone.
   */
  private readCache = new Map<string, { mtimeMs: number; size: number; epoch: number; lines: number }>();
  private contextEpoch = 0;
  /** files changed by write tools since the last verify call in this run */
  private editsSinceVerify = 0;
  private verifyNudged = false;
  /** weak-model nudges used in this run (empty replies, announced-but-not-called actions) */
  private replyNudges = { empty: 0, intent: 0 };
  private lastVerify: boolean | undefined;
  private runSkills = new Set<string>();
  private skillUses = new Map<string, number>();
  private lastContextTokens = 0;
  private prePlanMode: PermissionMode = 'auto-edit';
  private tools: ToolDefinition[] = [];
  private toolSpecs: ToolSpec[] = [];

  constructor(readonly opts: AgentOptions) {
    this.rt = opts.runtime;
    this.session = opts.session;
    this.mode = opts.session.mode ?? this.rt.config.safety.mode;
    this.policy = new PermissionPolicy(this.rt.config.safety);
    this.messages = this.rt.sessions.messages(this.session.id);
    const saved = this.session.meta?.todos;
    if (Array.isArray(saved)) this.todos = saved as Todo[];
    const rules = this.session.meta?.allowRules;
    if (Array.isArray(rules)) for (const r of rules) this.policy.allowForSession(String(r));
    // the last Codemaster on/off note in the history says whether the directive is in effect,
    // so an agent rebuilt after a restart (or after being evicted while idle) does not repeat it
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const cm = this.messages[i]?.meta?.codemaster;
      if (typeof cm === 'boolean') {
        this.codemasterActive = cm;
        break;
      }
    }
  }

  get id(): string {
    return this.session.id;
  }
  get title(): string {
    return this.session.title;
  }
  get isRunning(): boolean {
    return this.running;
  }
  get depth(): number {
    return this.opts.depth ?? 0;
  }
  history(): Message[] {
    return [...this.messages];
  }
  pendingRequests(): { permissions: string[]; clarify: string[] } {
    return { permissions: [...this.pendingPermissions.keys()], clarify: [...this.pendingClarify.keys()] };
  }

  private emit(e: AgentEvent): void {
    this.events.emit(e);
    this.rt.emitAgentEvent(this.session.id, e);
  }

  private notice(level: 'info' | 'warn' | 'error', text: string, code?: string): void {
    this.emit({ type: 'notice', runId: this.currentRunId, level, text, ...(code ? { code } : {}) });
  }

  private append(msgs: Message[]): void {
    if (!msgs.length) return;
    this.messages.push(...msgs);
    this.rt.sessions.appendMessages(this.session.id, msgs);
  }

  private saveSession(patch: Partial<SessionRecord>): void {
    const updated = this.rt.sessions.update(this.session.id, patch);
    if (updated) this.session = { ...this.session, ...updated };
  }

  // ---------------------------------------------------------------------------
  // Frozen per-session context (system prompt + tools) — keeps prompt caches warm
  // and the conversation append-only for providers that bind reasoning to it.
  // ---------------------------------------------------------------------------

  /** Small context windows get lean mode: core tools, short descriptions, a compact prompt. */
  private leanFor(model: ModelInfo): boolean {
    const mode = this.rt.config.agent.lean;
    return mode === 'on' || (mode !== 'off' && model.contextWindow <= 32_768);
  }

  private resolveTools(lean = false): ToolDefinition[] {
    const cfg = this.rt.config;
    const enabled = cfg.toolsets.enabled.filter((t) => !cfg.toolsets.disabled.includes(t));
    const only = this.opts.toolFilter?.only;
    const exclude = [...(this.opts.toolFilter?.exclude ?? [])];
    if (this.depth > 0) exclude.push('ask_user', 'exit_plan_mode');
    if (this.depth >= cfg.agent.subagents.maxDepth) exclude.push('delegate', 'agents');
    if (!this.opts.team) exclude.push('team_board');
    const deferred = new Set(deferredTools(this.rt, lean && !only).map((t) => t.name));
    const loaded = new Set(Array.isArray(this.session.meta?.loadedTools) ? (this.session.meta.loadedTools as string[]) : []);
    const tools = this.rt.tools
      .resolve(enabled, this.rt, { only, exclude })
      .filter((t) => (t.name === 'tool_search' ? deferred.size > 0 : !deferred.has(t.name) || loaded.has(t.name)));
    return [...(lean && !only ? tools.filter((t) => LEAN_TOOLS.has(t.name) || loaded.has(t.name)) : tools), ...(this.opts.extraTools ?? [])];
  }

  private ensureContext(model: ModelInfo): void {
    const lean = this.leanFor(model);
    // the frozen context is reused unless the model moved in or out of lean mode
    if (this.session.systemPrompt && this.session.toolNames && Boolean(this.session.meta?.lean) === lean) {
      const names = new Set(this.session.toolNames);
      this.tools = [...this.rt.tools.all(), ...(this.opts.extraTools ?? [])].filter((t) => names.has(t.name) && (!t.available || t.available(this.rt) === null));
      this.toolSpecs = this.rt.tools.specs(this.tools, lean);
      return;
    }
    this.tools = this.resolveTools(lean);
    this.toolSpecs = this.rt.tools.specs(this.tools, lean);
    const cfg = this.rt.config;
    const preloaded = (this.opts.preloadSkills ?? [])
      .map((name) => {
        try {
          return { name, content: this.rt.skills.read(name).content };
        } catch {
          return null;
        }
      })
      .filter((x): x is { name: string; content: string } => x !== null);
    const prompt = buildSystemPrompt({
      agentName: cfg.agent.name,
      surface: this.opts.surface ?? this.session.source.split(':')[0] ?? 'cli',
      cwd: this.session.cwd,
      model,
      mode: this.mode,
      backend: this.rt.backend.describe(),
      toolNames: this.tools.map((t) => t.name),
      soul: this.depth === 0 ? this.rt.soul() : undefined,
      personality: cfg.agent.personality,
      instructions: cfg.agent.instructions,
      contextFiles: discoverContextFiles(this.session.cwd, this.rt.home),
      memory: cfg.memory.enabled && this.tools.some((t) => t.name === 'memory') ? this.memoryBlock() : undefined,
      skillsIndex: cfg.skills.enabled && this.tools.some((t) => t.name === 'skill_view') ? this.rt.skills.promptIndex() : undefined,
      agentTypes: this.rt.agentDefinitions(this.session.cwd),
      mcpInstructions: this.rt.mcp.instructions() || undefined,
      subagent: this.depth > 0 ? { depth: this.depth, definition: this.opts.definition, context: this.opts.subagentContext } : undefined,
      preloadedSkills: preloaded,
      language: cfg.agent.language,
      checks: detectProjectChecks(this.session.cwd),
      team: this.opts.team ? { member: this.opts.team.member, teammates: this.opts.team.board.members.filter((m) => m !== this.opts.team!.member) } : undefined,
      lean,
    });
    this.saveSession({ systemPrompt: prompt, toolNames: this.tools.map((t) => t.name), meta: { lean } });
  }

  /** Memory notes, user profile and — with memory.recaps — the index of past work. */
  private memoryBlock(): string {
    const index = this.depth === 0 ? this.rt.recaps.index() : undefined;
    return `${this.rt.memory.snapshot()}${index ? `\n\nPAST WORK (index of earlier conversations)\n${index}` : ''}`;
  }

  /** Rebuild the frozen context (new memory/skills/tools) — starts a new cache prefix. */
  refreshContext(): void {
    this.saveSession({ systemPrompt: undefined, toolNames: undefined });
    this.session.systemPrompt = undefined;
    this.session.toolNames = undefined;
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  interrupt(): void {
    this.controller?.abort();
    for (const [id, resolve] of this.pendingPermissions) {
      resolve({ decision: 'deny', feedback: 'interrupted' });
      this.pendingPermissions.delete(id);
    }
    for (const [id, resolve] of this.pendingClarify) {
      resolve('');
      this.pendingClarify.delete(id);
    }
  }

  respondPermission(requestId: string, decision: PermissionDecision): boolean {
    const fn = this.pendingPermissions.get(requestId);
    if (!fn) return false;
    this.pendingPermissions.delete(requestId);
    fn(decision);
    return true;
  }

  respondClarify(requestId: string, answer: string): boolean {
    const fn = this.pendingClarify.get(requestId);
    if (!fn) return false;
    this.pendingClarify.delete(requestId);
    fn(answer);
    return true;
  }

  setMode(mode: PermissionMode, note = true): void {
    if (mode === this.mode) return;
    const prev = this.mode;
    if (mode === 'plan') this.prePlanMode = prev === 'plan' ? 'auto-edit' : prev;
    this.mode = mode;
    this.saveSession({ mode });
    if (note && this.messages.length) {
      const text =
        mode === 'plan'
          ? 'The user switched to PLAN MODE: read-only. Investigate, then present a plan with exit_plan_mode before changing anything.'
          : `Permission mode changed from "${prev}" to "${mode}".${prev === 'plan' ? ' Plan mode is over — you may now make changes.' : ''}`;
      this.append([{ id: newId('m_'), role: 'system', parts: [{ type: 'text', text }], createdAt: Date.now(), meta: { kind: 'notice' } }]);
    }
  }

  setModel(ref: string): ModelInfo {
    const info = this.rt.providers.resolve(ref);
    this.saveSession({ model: info.ref });
    return info;
  }

  setTodos(todos: Todo[]): void {
    this.todos = todos;
    this.saveSession({ meta: { todos } });
    this.emit({ type: 'todos', runId: this.currentRunId, todos });
  }

  noteRead(path: string): void {
    this.readFiles.add(path);
    this.stampFile(path);
  }

  /** Make deferred tools callable from the next model call on (tool_search). Returns how many were new. */
  loadTools(names: string[]): number {
    const have = new Set(this.tools.map((t) => t.name));
    const add = names.map((n) => this.rt.tools.get(n)).filter((t): t is ToolDefinition => !!t && !have.has(t.name));
    if (!add.length) return 0;
    this.tools = [...this.tools, ...add];
    this.toolSpecs = [...this.toolSpecs, ...this.rt.tools.specs(add, Boolean(this.session.meta?.lean))];
    const loaded = [...new Set([...(Array.isArray(this.session.meta?.loadedTools) ? (this.session.meta.loadedTools as string[]) : []), ...add.map((t) => t.name)])];
    this.saveSession({ toolNames: this.tools.map((t) => t.name), meta: { loadedTools: loaded } });
    return add.length;
  }

  /** Remember the version of `path` this agent has seen (after reading or writing it). */
  stampFile(path: string): void {
    try {
      const st = statSync(path);
      this.fileStamps.set(path, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      this.fileStamps.delete(path);
    }
  }

  /**
   * Stale-write guard: replacing a whole file is only safe when this agent knows its current
   * content. Returns why not — the file was never read here, or it changed on disk since (the
   * user, a formatter, a shell command or another agent) — or undefined when it is safe. The
   * warning is given once per file version, so a deliberate second attempt goes through.
   */
  staleWrite(path: string): string | undefined {
    let st;
    try {
      st = statSync(path);
    } catch {
      return undefined;
    }
    if (!st.isFile() || st.size === 0) return undefined;
    const stamp = this.fileStamps.get(path);
    const key = `${path}@${st.mtimeMs}:${st.size}`;
    if (stamp && stamp.mtimeMs === st.mtimeMs && stamp.size === st.size) return undefined;
    if (this.staleWarned.has(key)) return undefined;
    this.staleWarned.add(key);
    return stamp ? 'changed' : 'unread';
  }

  /** A read of this exact file and range whose (unchanged) content is still in the context. */
  cachedRead(key: string, mtimeMs: number, size: number): { lines: number } | undefined {
    const hit = this.readCache.get(key);
    return hit && hit.epoch === this.contextEpoch && hit.mtimeMs === mtimeMs && hit.size === size ? { lines: hit.lines } : undefined;
  }

  noteSkillUse(name: string): void {
    this.skillUses.set(name, (this.skillUses.get(name) ?? 0) + 1);
    this.runSkills.add(name);
    this.rt.recordSkillUse(name);
  }

  /** Result of the latest verify call; clears the "edited but unverified" state when it passed. */
  noteVerification(ok: boolean): void {
    this.lastVerify = ok;
    this.editsSinceVerify = 0;
  }

  get team(): { board: TeamBoard; member: string } | undefined {
    return this.opts.team;
  }

  /**
   * Skill changes the agent may still make in this session. Self-modification is useful but
   * overfits when unbounded, so each session gets a small budget (config skills.editBudget);
   * the count lives in the session record so it survives a rebuilt agent.
   */
  skillEditsLeft(): number {
    const used = Number(this.session.meta?.skillEdits ?? 0);
    return Math.max(0, this.rt.config.skills.editBudget - used);
  }

  noteSkillEdit(): void {
    this.saveSession({ meta: { ...this.session.meta, skillEdits: Number(this.session.meta?.skillEdits ?? 0) + 1 } });
  }

  // ---------------------------------------------------------------------------
  // Interactive requests
  // ---------------------------------------------------------------------------

  private async askPermission(req: Omit<PermissionRequest, 'requestId' | 'sessionId'>): Promise<PermissionDecision> {
    let request: PermissionRequest = { ...req, requestId: newId('perm_'), sessionId: this.session.id };
    const unattended = !this.opts.onPermission;
    if (this.rt.hooks.has('permissionRequest')) {
      const h = await this.rt.hooks.run('permissionRequest', { sessionId: this.session.id, toolName: req.toolName, input: req.input, reason: req.reason, dangerous: Boolean(req.dangerous), mode: this.mode }, { toolName: req.toolName, cwd: this.session.cwd });
      if (h.blocked) return { decision: 'deny', feedback: `Refused by a permissionRequest hook: ${h.reason}` };
      if (h.allow) return { decision: 'allow' };
    }
    const guardian = this.rt.config.safety.guardian?.mode ?? 'off';
    if (guardian === 'always' || (guardian === 'unattended' && unattended && this.opts.autoApprove)) {
      try {
        const v = await reviewAction(this.rt, {
          messages: this.messages,
          action: { tool: req.toolName, input: req.input, cwd: this.session.cwd, reason: req.reason ?? '' },
          model: this.session.model || undefined,
          signal: this.controller?.signal,
        });
        this.notice(v.outcome === 'allow' ? 'info' : 'warn', `Safety reviewer ${v.outcome === 'allow' ? 'approved' : 'refused'} ${req.summary} (${v.risk} risk, ${v.authorization} authorization): ${v.rationale}`);
        if (v.outcome === 'allow') return { decision: 'allow' };
        if (unattended) return { decision: 'deny', feedback: `The safety reviewer refused it (${v.risk} risk): ${v.rationale}` };
        request = { ...request, reason: `${request.reason ?? ''} — safety reviewer: ${v.rationale}` };
      } catch (e) {
        log.warn('safety review failed', e);
        // without a verdict, an unattended run only goes ahead with actions that are not dangerous
        if (unattended && this.opts.autoApprove) return req.dangerous ? { decision: 'deny', feedback: `Not run: the safety review failed (${errorMessage(e)}) and the action is dangerous.` } : { decision: 'allow' };
      }
    }
    if (!this.opts.onPermission) {
      if (this.opts.autoApprove) return { decision: 'allow' };
      return { decision: 'deny', feedback: 'No one is available to approve this action in a non-interactive run.' };
    }
    this.emit({ type: 'permission_request', runId: this.currentRunId, request });
    const decision = await new Promise<PermissionDecision>((resolve) => {
      this.pendingPermissions.set(request.requestId, resolve);
      this.opts
        .onPermission?.(request)
        .then((d) => {
          if (this.pendingPermissions.has(request.requestId)) {
            this.pendingPermissions.delete(request.requestId);
            resolve(d);
          }
        })
        .catch(() => undefined);
    });
    this.emit({ type: 'permission_resolved', runId: this.currentRunId, requestId: request.requestId, decision: decision.decision });
    return decision;
  }

  private async askClarify(question: string, options?: string[]): Promise<string> {
    if (!this.opts.onClarify) return '';
    const request: ClarifyRequest = { requestId: newId('ask_'), sessionId: this.session.id, question, options };
    this.emit({ type: 'clarify_request', runId: this.currentRunId, request });
    const answer = await new Promise<string>((resolve) => {
      this.pendingClarify.set(request.requestId, resolve);
      this.opts
        .onClarify?.(request)
        .then((a) => {
          if (this.pendingClarify.has(request.requestId)) {
            this.pendingClarify.delete(request.requestId);
            resolve(a);
          }
        })
        .catch(() => undefined);
    });
    this.emit({ type: 'clarify_resolved', runId: this.currentRunId, requestId: request.requestId, answer });
    return answer;
  }

  async requestPlanApproval(plan: string): Promise<{ approved: boolean; feedback?: string }> {
    const d = await this.askPermission({
      toolCallId: '',
      toolName: 'exit_plan_mode',
      input: { plan },
      summary: 'Approve the plan and start implementing',
      risk: 'write',
      reason: 'The agent finished planning and wants to start making changes.',
    });
    if (d.decision === 'deny') return { approved: false, feedback: d.feedback };
    this.setMode(this.prePlanMode === 'plan' ? 'auto-edit' : this.prePlanMode, false);
    return { approved: true };
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  private userTurnIndex(): number {
    return this.messages.filter((m) => m.role === 'user' && m.meta?.kind !== 'summary').length;
  }

  async run(input: UserInput | string, opts: AgentRunOptions = {}): Promise<AgentRunResult> {
    if (this.running) throw new Error('This agent is already running. Interrupt it or wait for it to finish.');
    // A session that was pinned to the demo model only because nothing was connected follows the
    // default again, so connecting a provider later takes effect in existing chats too.
    if (this.session.model?.startsWith('kronos:') && !this.rt.providers.demoAllowed(opts.model)) this.saveSession({ model: '' });
    const ready = this.rt.providers.readiness(opts.model ?? (this.session.model || undefined));
    if (!ready.ok) {
      // never answer with the offline demo model by accident: keep the message, say what is missing
      const error = new NotConnectedError(ready.provider).message;
      this.holdUnanswered(typeof input === 'string' ? { text: input } : input);
      this.notice('error', error, 'no_provider');
      return { runId: '', text: '', stopReason: 'error', usage: emptyUsage(), durationMs: 0, error, toolCalls: 0 };
    }
    const inp: UserInput = typeof input === 'string' ? { text: input } : input;
    this.running = true;
    const runId = newId('r_');
    this.currentRunId = runId;
    const started = Date.now();
    this.controller = new AbortController();
    const onOuterAbort = () => this.controller?.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const signal = this.controller.signal;

    this.editsSinceVerify = 0;
    this.verifyNudged = false;
    this.bgNudged = false;
    this.replyNudges = { empty: 0, intent: 0 };
    this.lastVerify = undefined;
    this.runSkills.clear();
    let runUsage = emptyUsage();
    let finalText = '';
    let stop: StopReason = 'end_turn';
    let error: string | undefined;
    let toolCallCount = 0;
    let partialText = '';
    const cfg = this.rt.config;
    let model = this.rt.providers.resolve(opts.model ?? (this.session.model || undefined));
    if (!this.session.model) this.saveSession({ model: model.ref });
    this.emit({ type: 'run_start', runId, sessionId: this.session.id, model: model.ref });

    try {
      this.ensureContext(model);

      // userPromptSubmit hook
      let userText = inp.text;
      if (this.rt.hooks.has('userPromptSubmit')) {
        const h = await this.rt.hooks.run('userPromptSubmit', { sessionId: this.session.id, prompt: userText }, { cwd: this.session.cwd });
        if (h.blocked) {
          this.notice('warn', `Prompt blocked by hook: ${h.reason}`);
          stop = 'end_turn';
          finalText = '';
          return this.finish(runId, started, finalText, stop, runUsage, undefined, 0);
        }
        if (h.context) userText += `\n\n<hook-context>\n${h.context}\n</hook-context>`;
      }
      const isFirstTurn = !this.messages.some((m) => m.role === 'user');
      if (isFirstTurn && this.rt.hooks.has('sessionStart')) {
        const h = await this.rt.hooks.run('sessionStart', { sessionId: this.session.id, cwd: this.session.cwd }, { cwd: this.session.cwd });
        if (h.context) userText = `<session-context>\n${h.context}\n</session-context>\n\n${userText}`;
      }

      const userParts: Part[] = [];
      if (userText) userParts.push({ type: 'text', text: userText });
      for (const f of inp.files ?? []) userParts.push(f);
      for (const img of inp.images ?? []) userParts.push(img);
      const userMsg: Message = { id: newId('m_'), role: 'user', parts: userParts, createdAt: Date.now(), meta: inp.meta };
      this.append([userMsg]);
      this.emit({ type: 'message', runId, message: userMsg });

      // Codemaster: max effort plus a rigorous workflow, announced when it is switched on or off
      const codemaster = cfg.model.effort === 'codemaster' && this.depth === 0;
      if (codemaster !== this.codemasterActive) {
        const wasOn = this.codemasterActive;
        this.codemasterActive = codemaster;
        if (codemaster || wasOn) {
          this.append([
            {
              id: newId('m_'),
              role: 'system',
              parts: [{ type: 'text', text: codemaster ? codemasterDirective(this.toolSpecs.map((t) => t.name)) : 'Codemaster mode is now off: return to your normal workflow.' }],
              createdAt: Date.now(),
              meta: { kind: 'note', codemaster },
            },
          ]);
        }
      }

      // learning-loop nudge
      const turns = this.userTurnIndex();
      const every = cfg.agent.nudges.memoryEvery;
      if (cfg.memory.enabled && every > 0 && turns > 0 && turns % every === 0 && this.depth === 0) {
        this.append([
          {
            id: newId('m_'),
            role: 'system',
            parts: [{ type: 'text', text: 'Periodic reminder: if this conversation revealed durable facts about the user, their preferences or the environment, save them with the memory tool (briefly) before continuing.' }],
            createdAt: Date.now(),
            meta: { kind: 'note' },
          },
        ]);
      }

      const turn = turns;
      let maxTokens = Math.min(cfg.model.maxOutputTokens, model.maxOutput || cfg.model.maxOutputTokens);
      const maxIter = opts.maxIterations ?? cfg.agent.maxIterations;
      const watch = new LoopWatch();
      let lastText = '';

      for (let iter = 1; iter <= maxIter; iter += 1) {
        if (signal.aborted) throw abortError();
        const over = iter > 1 ? overBudget(cfg.agent.budget, runUsage, started) : '';
        if (over) {
          stop = 'budget';
          finalText = lastText;
          this.notice('warn', `Stopped: this run reached its budget (${over}). Say "continue" to keep going.`);
          break;
        }
        await this.maybeCompact(model, runId, signal);
        this.emit({ type: 'turn_start', runId, iteration: iter });
        partialText = '';
        const req: ChatRequest = {
          model,
          system: this.session.systemPrompt ?? '',
          messages: this.messages,
          tools: this.toolSpecs,
          maxTokens,
          effort: cfg.model.effort === 'codemaster' ? 'max' : cfg.model.effort,
          thinking: cfg.model.thinking,
          showThinking: cfg.model.showThinking,
          temperature: cfg.model.temperature ?? undefined,
          toolMode: cfg.model.toolMode,
          signal,
          sessionId: this.session.id,
        };
        const res = await this.rt.providers.chat(req, (e) => {
          switch (e.type) {
            case 'text':
              partialText += e.text;
              this.emit({ type: 'text_delta', runId, text: e.text });
              break;
            case 'thinking':
              this.emit({ type: 'thinking_delta', runId, text: e.text });
              break;
            case 'tool_call_start':
              this.emit({ type: 'tool_call_start', runId, id: e.id, name: e.name });
              break;
            case 'tool_call_delta':
              this.emit({ type: 'tool_call_delta', runId, id: e.id, partialJson: e.partialJson });
              break;
            case 'notice':
              this.notice(e.level, e.text);
              break;
            case 'restart':
              // a retry or fallback starts over: clients drop what the failed attempt streamed
              partialText = '';
              this.emit({ type: 'turn_start', runId, iteration: iter });
              break;
          }
        });
        if (res.modelInfo.ref !== model.ref) model = res.modelInfo;

        // usage + cost
        const cost = res.usage.costUsd ?? costOf(res.modelInfo, res.usage);
        const usage: Usage = { ...res.usage, costUsd: cost };
        runUsage = addUsage(runUsage, usage);
        this.saveSession({ usage: addUsage(this.session.usage ?? emptyUsage(), usage) });
        const toolCalls = res.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
        // `bash`, `str_replace`, `functions.read_file` …: record the call under the tool it meant
        const toolNames = this.tools.map((t) => t.name);
        for (const c of toolCalls) c.name = resolveToolName(c.name, toolNames) ?? c.name;
        this.rt.sessions.logUsage({
          ts: Date.now(), sessionId: this.session.id, model: res.modelInfo.ref, source: this.session.source,
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens, costUsd: cost, toolCalls: toolCalls.length,
        });
        this.lastContextTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
        this.emit({ type: 'usage', runId, usage, total: this.session.usage, contextTokens: this.lastContextTokens, contextWindow: model.contextWindow });

        if (res.stopReason === 'max_tokens' && toolCalls.length) {
          // a tool input was cut off: never run it; retry the turn with more room
          if (maxTokens < (model.maxOutput || maxTokens)) {
            maxTokens = Math.min(model.maxOutput, maxTokens * 2);
            this.notice('warn', `Output limit reached mid tool call — retrying with max_tokens=${maxTokens}.`);
            continue;
          }
          stop = 'max_tokens';
          error = 'The model hit its output limit while writing a tool call.';
          break;
        }

        const assistant: Message = {
          id: newId('m_'),
          role: 'assistant',
          parts: res.parts,
          createdAt: Date.now(),
          model: res.modelInfo.ref,
          usage,
          stopReason: res.stopReason,
        };
        if (res.parts.length) {
          this.append([assistant]);
          this.emit({ type: 'message', runId, message: assistant });
        }
        partialText = '';
        lastText = textOf(res.parts) || lastText;

        if (res.stopReason === 'refusal') {
          stop = 'refusal';
          finalText = textOf(res.parts);
          this.notice('warn', `The model declined this request${res.refusal?.category ? ` (${res.refusal.category})` : ''}.${res.refusal?.explanation ? ` ${res.refusal.explanation}` : ''}`);
          break;
        }
        if (res.stopReason === 'pause_turn') continue;
        if (!toolCalls.length) {
          const nudge = res.stopReason === 'end_turn' && iter < maxIter && this.tools.length ? this.replyNudge(textOf(res.parts)) : undefined;
          if (nudge) {
            this.append([{ id: newId('m_'), role: 'system', parts: [{ type: 'text', text: nudge }], createdAt: Date.now(), meta: { kind: 'note' } }]);
            continue;
          }
          const pendingAgents = [...this.bgAgents.values()].filter((a) => a.status === 'running' || !a.reported);
          if (res.stopReason === 'end_turn' && iter < maxIter && pendingAgents.length && !this.bgNudged) {
            this.bgNudged = true;
            this.append([{ id: newId('m_'), role: 'system', parts: [{ type: 'text', text: `Background agents ${pendingAgents.map((a) => `${a.id} (${a.label}, ${a.status})`).join(', ')} have results you have not collected. Call agents(action: "wait") to get them (or "stop" those you no longer need) before your final answer.` }], createdAt: Date.now(), meta: { kind: 'note' } }]);
            continue;
          }
          if (res.stopReason !== 'max_tokens' && iter < maxIter && this.shouldVerifyBeforeFinish()) {
            // verification is a property of the harness, not a request in the prompt
            this.verifyNudged = true;
            this.notice('info', 'Asking for verification before finishing (files changed, no verify run since).');
            this.append([
              {
                id: newId('m_'),
                role: 'system',
                parts: [
                  {
                    type: 'text',
                    text: `You changed ${this.editsSinceVerify} file(s) in this run but have not run verify since. Run verify now (or the specific command that proves the change works), fix what fails and re-run until it passes, then give your final answer. If it truly cannot be verified here, say why in your answer instead.`,
                  },
                ],
                createdAt: Date.now(),
                meta: { kind: 'note' },
              },
            ]);
            continue;
          }
          finalText = textOf(res.parts);
          stop = res.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn';
          break;
        }

        toolCallCount += toolCalls.length;
        const results = await this.executeTools(toolCalls, runId, turn, signal);
        const toolMsg: Message = { id: newId('m_'), role: 'tool', parts: results, createdAt: Date.now() };
        this.append([toolMsg]);
        this.emit({ type: 'message', runId, message: toolMsg });
        if (signal.aborted) throw abortError();
        const verdict = watch.observe(toolCalls.map((c, i) => ({ name: c.name, input: c.input, isError: Boolean(results[i]?.isError), content: results[i]?.content ?? '' })));
        if (verdict.kind === 'stop') {
          stop = 'stalled';
          finalText = lastText;
          this.notice('warn', verdict.reason);
          break;
        }
        if (verdict.kind === 'warn') {
          this.append([{ id: newId('m_'), role: 'system', parts: [{ type: 'text', text: verdict.note }], createdAt: Date.now(), meta: { kind: 'note' } }]);
        }
        if (iter === maxIter) {
          stop = 'max_iterations';
          finalText = textOf(res.parts);
          this.notice('warn', `Stopped after ${maxIter} iterations. Say "continue" to keep going.`);
        }
      }

      const learning = cfg.agent.nudges.learning ?? 'inline';
      const lastUserText = messageText(this.lastUserMessage() ?? { parts: [] } as unknown as Message);
      if (learning === 'background' && this.depth === 0 && stop === 'end_turn' && (cfg.skills.autoCreate || cfg.memory.enabled) && (toolCallCount >= cfg.agent.nudges.skillAfterToolCalls || hasLearningSignal(lastUserText))) {
        void this.rt.track(this.learningReview());
      } else if (learning === 'inline' && cfg.skills.autoCreate && toolCallCount >= cfg.agent.nudges.skillAfterToolCalls && this.depth === 0 && stop === 'end_turn') {
        this.append([
          {
            id: newId('m_'),
            role: 'system',
            parts: [{ type: 'text', text: `The previous task took ${toolCallCount} tool calls. If it is a workflow likely to recur, consider capturing it as a skill (skill_manage create) or improving the skill you used.` }],
            createdAt: Date.now(),
            meta: { kind: 'note' },
          },
        ]);
      }
    } catch (e) {
      if (isAbortError(e) || signal.aborted) {
        stop = 'interrupted';
        this.repairAfterInterrupt(partialText);
        finalText = partialText;
      } else {
        stop = 'error';
        error = errorMessage(e);
        log.error('run failed', e);
        this.notice('error', error);
      }
    } finally {
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
    return this.finish(runId, started, finalText, stop, runUsage, error, toolCallCount);
  }

  /**
   * Weaker models end turns in two ways that leave the task undone: an empty reply, or a reply that
   * announces the next action ("Let me run the tests.") without calling a tool. One short nudge each
   * gets them going again; a final answer is never blocked twice.
   */
  private replyNudge(text: string): string | undefined {
    const reply = text.trim();
    if (!reply && this.replyNudges.empty < 2) {
      this.replyNudges.empty++;
      return 'Your last reply was empty. Continue the task: call the next tool, or write your final answer if the task is done.';
    }
    if (reply && this.replyNudges.intent < 1 && ANNOUNCED_ACTION.test(reply.slice(-240))) {
      this.replyNudges.intent++;
      return 'You described your next step but did not call a tool, so nothing happened. Call the tool now. If the task is already done, give your final answer instead.';
    }
    return undefined;
  }

  private shouldVerifyBeforeFinish(): boolean {
    if (this.verifyNudged || this.editsSinceVerify === 0 || this.mode === 'plan') return false;
    if (!this.rt.config.agent.verifyBeforeFinish || !this.toolSpecs.some((t) => t.name === 'verify')) return false;
    // only when the project says how to verify itself; otherwise there is nothing concrete to ask for
    return detectProjectChecks(this.session.cwd).length > 0;
  }

  private finish(runId: string, started: number, text: string, stopReason: StopReason, usage: Usage, error: string | undefined, toolCalls: number): AgentRunResult {
    this.running = false;
    this.controller = undefined;
    if (this.runSkills.size) {
      // outcome per skill used: feeds pruning and the skill library's success rates
      const ok = stopReason === 'end_turn' && !error && this.lastVerify !== false;
      this.rt.recordSkillOutcome([...this.runSkills], ok);
    }
    const durationMs = Date.now() - started;
    this.emit({ type: 'run_end', runId, stopReason, text, usage, durationMs, error });
    if (this.rt.hooks.has('stop')) {
      void this.rt.track(this.rt.hooks.run('stop', { sessionId: this.session.id, stopReason, text: truncate(text, 4000) }, { cwd: this.session.cwd }));
    }
    if (this.depth === 0 && this.rt.config.agent.autoTitle && (this.session.title === 'New conversation' || !this.session.title)) {
      void this.rt.track(this.autoTitle());
    }
    const mem = this.rt.config.memory;
    if (this.depth === 0 && mem.enabled && mem.autoExtract && !error && stopReason === 'end_turn' && text.trim()) {
      void this.rt.track(this.extractMemories(text));
    }
    if (this.depth === 0 && mem.enabled && mem.recaps) {
      this.rt.recaps.schedule();
    }
    return { runId, text, stopReason, usage, durationMs, error, toolCalls };
  }

  /** Keep history valid after an interrupt: keep partial text, answer dangling tool calls. */
  private repairAfterInterrupt(partialText: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'assistant') {
      const calls = last.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
      if (calls.length) {
        this.append([
          {
            id: newId('m_'),
            role: 'tool',
            parts: calls.map((c) => ({ type: 'tool_result', toolCallId: c.id, toolName: c.name, content: 'Interrupted by the user before this tool finished.', isError: true })),
            createdAt: Date.now(),
            meta: { interrupted: true },
          },
        ]);
      }
    } else if (partialText.trim()) {
      this.append([{ id: newId('m_'), role: 'assistant', parts: [{ type: 'text', text: `${partialText}\n\n[interrupted]` }], createdAt: Date.now(), meta: { interrupted: true } }]);
    }
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private async executeTools(calls: ToolCallPart[], runId: string, turn: number, signal: AbortSignal): Promise<ToolResultPart[]> {
    const results: (ToolResultPart | undefined)[] = new Array(calls.length);
    const runnable: { index: number; call: ToolCallPart; def: ToolDefinition; input: Record<string, unknown> }[] = [];
    const known = new Set(this.tools.map((t) => t.name));

    // 1. validate + authorize sequentially (permission prompts are interactive)
    for (const [index, call] of calls.entries()) {
      const fail = (content: string) => {
        results[index] = { type: 'tool_result', toolCallId: call.id, toolName: call.name, content, isError: true };
        this.emit({ type: 'tool_result', runId, id: call.id, name: call.name, content, isError: true, durationMs: 0 });
      };
      const def = known.has(call.name) ? this.tools.find((t) => t.name === call.name) : undefined;
      if (!def) {
        this.emit({ type: 'tool_call', runId, id: call.id, name: call.name, input: call.input, summary: call.name, toolset: 'unknown' });
        fail(`Unknown tool "${call.name}". Did you mean ${suggestTools(call.name, known).map((n) => `"${n}"`).join(' or ')}? Available tools: ${[...known].join(', ')}`);
        continue;
      }
      if ('__raw' in call.input) {
        this.emit({ type: 'tool_call', runId, id: call.id, name: call.name, input: call.input, summary: call.name, toolset: def.toolset });
        fail(`INVALID_JSON: the tool arguments were not valid JSON: ${truncate(String(call.input.__raw), 300)}${usageHint(def)}`);
        continue;
      }
      const v = validateInput(def.parameters, call.input);
      const input = v.value;
      let summary = call.name;
      try {
        summary = def.summarize?.(input as never) ?? call.name;
      } catch {
        /* ignore */
      }
      this.emit({ type: 'tool_call', runId, id: call.id, name: call.name, input, summary, toolset: def.toolset });
      if (!v.ok) {
        fail(`Invalid arguments for ${call.name}: ${v.errors.join('; ')}${usageHint(def)}`);
        continue;
      }
      if (this.rt.hooks.has('preToolUse')) {
        const h = await this.rt.hooks.run('preToolUse', { sessionId: this.session.id, toolName: call.name, input }, { toolName: call.name, cwd: this.session.cwd });
        if (h.blocked) {
          fail(`Blocked by a preToolUse hook: ${h.reason}`);
          continue;
        }
      }
      const risk = resolveRisk(def, input);
      const check = this.policy.check({ name: call.name, toolset: def.toolset, risk, input, cwd: this.session.cwd, sandboxed: this.rt.sandboxActive() }, this.mode);
      if (check.action === 'deny') {
        fail(`Permission denied: ${check.reason}`);
        continue;
      }
      if (check.action === 'ask') {
        const decision = await this.askPermission({ toolCallId: call.id, toolName: call.name, input, summary, risk, reason: check.reason, dangerous: check.dangerous });
        if (decision.decision === 'deny') {
          fail(`The user denied this action.${decision.feedback ? ` Their feedback: ${decision.feedback}` : ''} Do not retry it in another form; adjust your approach or ask.`);
          continue;
        }
        if (decision.decision === 'allow_session' || decision.decision === 'allow_always') {
          const rule = check.suggestedRule ?? call.name;
          this.policy.allowForSession(rule);
          this.saveSession({ meta: { allowRules: this.policy.sessionRules() } });
          if (decision.decision === 'allow_always' && !check.dangerous) this.rt.addAllowRule(rule);
        }
      }
      runnable.push({ index, call, def, input });
    }

    // 2. execute: parallel-safe calls concurrently, the rest in order
    const exec = async (r: (typeof runnable)[number]) => {
      results[r.index] = await this.runTool(r.call, r.def, r.input, runId, turn, signal);
    };
    const parallel = this.rt.config.agent.parallelTools ? runnable.filter((r) => r.def.parallelSafe) : [];
    const sequential = runnable.filter((r) => !parallel.includes(r));
    await mapLimit(parallel, 8, exec);
    for (const r of sequential) {
      if (signal.aborted) {
        results[r.index] = { type: 'tool_result', toolCallId: r.call.id, toolName: r.call.name, content: 'Interrupted by the user.', isError: true };
        continue;
      }
      await exec(r);
    }
    return results.map((r, i) => r ?? { type: 'tool_result', toolCallId: (calls[i] as ToolCallPart).id, toolName: (calls[i] as ToolCallPart).name, content: 'not executed', isError: true });
  }

  private async runTool(call: ToolCallPart, def: ToolDefinition, input: Record<string, unknown>, runId: string, turn: number, signal: AbortSignal): Promise<ToolResultPart> {
    const started = Date.now();
    const ctx: ToolContext = {
      runtime: this.rt,
      agent: this,
      sessionId: this.session.id,
      cwd: this.session.cwd,
      signal,
      toolCallId: call.id,
      turn,
      progress: (text) => this.emit({ type: 'tool_progress', runId, id: call.id, text }),
      askUser: (q, options) => this.askClarify(q, options),
      checkpoint: (path) => {
        if (this.rt.config.safety.checkpoints) {
          try {
            this.rt.checkpoints.snapshot(this.session.id, turn, path, truncate(textOf(this.lastUserMessage()?.parts ?? []), 80));
          } catch (e) {
            log.warn('checkpoint failed', e);
          }
        }
      },
    };
    // the edited files as they were, for the language-server diagnostics delta
    const lspOn = this.rt.config.agent.lsp === 'auto' && EDIT_TOOLS.has(call.name);
    const before = new Map<string, string | null>();
    if (lspOn) {
      const targets = [input.path, input.file_path].filter((p): p is string => typeof p === 'string');
      if (call.name === 'apply_patch' && typeof input.patch === 'string') for (const m of input.patch.matchAll(/^(?:\*\*\* (?:Update|Add) File: |\+\+\+ b\/)(.+)$/gm)) targets.push((m[1] as string).trim());
      for (const t of targets.slice(0, 10)) {
        const abs = isAbsolute(t) ? t : resolve(this.session.cwd, t);
        if (!this.rt.lsp.available(abs)) continue;
        try {
          before.set(abs, readFileSync(abs, 'utf8'));
        } catch {
          before.set(abs, null);
        }
      }
    }
    let out;
    try {
      out = await def.execute(input as never, ctx);
    } catch (e) {
      out = { content: isAbortError(e) ? 'Interrupted by the user.' : `Error: ${errorMessage(e)}`, isError: true };
    }
    if (!out.isError && def.toolset === 'files' && resolveRisk(def, input) === 'write') {
      this.editsSinceVerify += 1;
      this.readCache.clear();
    }
    let content = out.content ?? '';
    if (this.rt.config.safety.redactSecrets) content = redactSecrets(content);
    const limit = this.rt.config.agent.toolOutputLimit;
    let meta = out.meta;
    if (content.length > limit) {
      const file = join(this.rt.paths.outputs, `${call.name}-${call.id.slice(-8)}.txt`);
      try {
        mkdirSync(this.rt.paths.outputs, { recursive: true });
        writeFileSync(file, content);
      } catch {
        /* ignore */
      }
      const t = truncateMiddle(content, limit);
      content = `${t.text}\n\n[full output (${out.content.length.toLocaleString()} chars) saved to ${file} — read_file/grep it for details]`;
      meta = { ...meta, truncated: true, fullOutputPath: file };
    }
    // a file that no longer parses is reported in the same result, while the change is in view
    if (!out.isError && EDIT_TOOLS.has(call.name) && this.rt.config.agent.editDiagnostics) {
      const paths = [...(meta?.paths ?? []), ...(meta?.path ? [meta.path] : [])];
      let failed = 0;
      for (const p of [...new Set(paths)].slice(0, 10)) {
        const abs = isAbsolute(p) ? p : resolve(this.session.cwd, p);
        let text: string;
        try {
          text = readFileSync(abs, 'utf8');
        } catch {
          continue; // deleted or moved
        }
        const problems = await syntaxProblems(abs, text, this.session.cwd);
        if (!problems.length) continue;
        failed += problems.length;
        content += formatSyntaxProblems(relative(this.session.cwd, abs) || abs, text, problems);
      }
      if (failed) meta = { ...meta, syntaxErrors: failed };
      // semantic errors the edit introduced (only when the syntax is fine)
      if (!failed && before.size) {
        let semantic = 0;
        for (const [abs, old] of before) {
          let text: string;
          try {
            text = readFileSync(abs, 'utf8');
          } catch {
            continue;
          }
          const r = await this.rt.lsp.introduced(abs, old, text, this.session.cwd);
          if (!r?.errors.length) continue;
          semantic += r.errors.length;
          content += formatLspErrors(relative(this.session.cwd, abs) || abs, r.server, r.errors);
        }
        if (semantic) meta = { ...meta, lspErrors: semantic };
      }
    }
    // remember complete reads (output that was cut is not fully in context, so it does not count)
    const read = meta?.read as { key: string; mtimeMs: number; size: number; lines: number } | undefined;
    if (call.name === 'read_file' && read && !out.isError && !meta?.truncated) {
      this.readCache.set(read.key, { mtimeMs: read.mtimeMs, size: read.size, lines: read.lines, epoch: this.contextEpoch });
    }
    if (this.rt.hooks.has('postToolUse')) {
      const h = await this.rt.hooks.run('postToolUse', { sessionId: this.session.id, toolName: call.name, input, output: truncate(content, 20_000), isError: Boolean(out.isError) }, { toolName: call.name, cwd: this.session.cwd });
      if (h.context) content += `\n\n<hook-feedback>\n${h.context}\n</hook-feedback>`;
      if (h.blocked) content += `\n\n<hook-feedback>\n${h.reason}\n</hook-feedback>`;
    }
    const durationMs = Date.now() - started;
    const images = out.images?.length && this.supportsVision() ? out.images : undefined;
    this.emit({ type: 'tool_result', runId, id: call.id, name: call.name, content, isError: Boolean(out.isError), durationMs, meta: { ...meta, durationMs }, images: out.images });
    for (const a of meta?.artifacts ?? []) this.emit({ type: 'artifact', runId, artifact: { ...a, id: newId('a_') } });
    return { type: 'tool_result', toolCallId: call.id, toolName: call.name, content, images, isError: Boolean(out.isError), meta: meta ? { ...meta, durationMs } : { durationMs } };
  }

  private supportsVision(): boolean {
    const m = this.rt.providers.resolve(this.session.model || undefined);
    return m.vision !== false;
  }

  private lastUserMessage(): Message | undefined {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i] as Message;
      if (m.role === 'user' && m.meta?.kind !== 'summary') return m;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Context management
  // ---------------------------------------------------------------------------

  /** tokens of the frozen system prompt + tool schemas, recomputed only when they change */
  private fixedTokens = { prompt: '', specs: [] as ToolSpec[], tokens: 0 };

  contextUsage(): { tokens: number; window: number; percent: number } {
    const model = this.rt.providers.resolve(this.session.model || undefined);
    const prompt = this.session.systemPrompt ?? '';
    if (this.fixedTokens.prompt !== prompt || this.fixedTokens.specs !== this.toolSpecs) {
      this.fixedTokens = { prompt, specs: this.toolSpecs, tokens: estimateTokens(prompt) + estimateTokens(JSON.stringify(this.toolSpecs)) };
    }
    const est = estimateMessagesTokens(this.messages) + this.fixedTokens.tokens;
    const tokens = Math.max(est, this.lastContextTokens);
    return { tokens, window: model.contextWindow, percent: Math.round((tokens / model.contextWindow) * 100) };
  }

  private async maybeCompact(model: ModelInfo, runId: string, signal: AbortSignal): Promise<void> {
    const c = this.rt.config.agent.compaction;
    if (!c.enabled || this.messages.length < 6) return;
    const limit = model.contextWindow * c.threshold;
    if (this.contextUsage().tokens < limit) return;
    // 1. cheap first: drop the bodies of old tool outputs (the calls and their order stay)
    if (c.clearToolResults) {
      const cleared = this.clearOldToolResults(c.keepToolResults);
      if (cleared.count) {
        const now = this.contextUsage().tokens;
        this.notice('info', `Cleared ${cleared.count} old tool output${cleared.count === 1 ? '' : 's'} (~${cleared.tokens.toLocaleString()} tokens) to make room.`);
        // enough headroom that the next few steps do not land here again
        if (now < limit * 0.75) return;
      }
    }
    // 2. summarize everything before the most recent turns
    try {
      await this.compact(runId, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      // 3. the summary call failed (provider down, ...): trim instead of failing the user's task
      this.trimWithoutSummary(runId, errorMessage(e));
    }
  }

  /**
   * Replaces the content of tool results older than the `keep` most recent ones with a short stub.
   * Only the in-memory context changes: the stored session keeps every output for the UI and search.
   */
  private clearOldToolResults(keep: number): { count: number; tokens: number } {
    const positions: [number, number][] = [];
    this.messages.forEach((m, i) => m.parts.forEach((p, j) => p.type === 'tool_result' && positions.push([i, j])));
    const old = positions.slice(0, Math.max(0, positions.length - keep));
    let count = 0;
    let tokens = 0;
    const changed = new Map<number, Part[]>();
    for (const [i, j] of old) {
      const parts = changed.get(i) ?? [...(this.messages[i] as Message).parts];
      const p = parts[j] as Extract<Part, { type: 'tool_result' }>;
      if (p.meta?.cleared || p.content.length < 600) continue;
      tokens += estimateTokens(p.content) - 30;
      parts[j] = {
        ...p,
        content: `[Output cleared to save context (${p.content.length.toLocaleString()} chars). Run the tool again if you need it.]`,
        images: undefined,
        meta: { ...p.meta, cleared: true },
      };
      changed.set(i, parts);
      count++;
    }
    if (!count) return { count, tokens: 0 };
    this.messages = this.messages.map((m, i) => (changed.has(i) ? { ...m, parts: changed.get(i) as Part[] } : m));
    this.contextEpoch += 1; // earlier reads are no longer in context
    this.lastContextTokens = 0;
    return { count, tokens: Math.max(0, tokens) };
  }

  /** Index where the verbatim tail starts: the `turns`-th most recent real user message (not a tool result or summary). */
  private tailStart(turns: number): number {
    if (turns <= 0) return this.messages.length;
    let seen = 0;
    for (let i = this.messages.length - 1; i > 0; i--) {
      const m = this.messages[i] as Message;
      if (m.role === 'user' && m.meta?.kind !== 'summary' && m.parts.some((p) => p.type !== 'tool_result') && ++seen === turns) return i;
    }
    return this.messages.length;
  }

  /** How many recent turns to keep verbatim: as configured, fewer when they alone would fill too much of the window. */
  private keptTail(model: ModelInfo): number {
    const c = this.rt.config.agent.compaction;
    const budget = model.contextWindow * c.threshold * 0.4;
    for (let turns = c.keepRecentTurns; turns > 0; turns--) {
      const start = this.tailStart(turns);
      if (start >= this.messages.length) continue;
      if (start > 0 && estimateMessagesTokens(this.messages.slice(start)) <= budget) return start;
    }
    return this.messages.length;
  }

  /** Swap the live history for `next`, archiving everything that leaves it (originals, not cleared stubs). */
  private replaceHistory(next: Message[], runId: string, before: number): { before: number; after: number } {
    const keep = new Set(next.map((m) => m.id));
    const stored = this.rt.sessions.messages(this.session.id);
    const original = new Map(stored.map((m) => [m.id, m]));
    this.messages = next;
    this.contextEpoch += 1;
    // store the kept messages as they were, not with outputs cleared from the context
    this.rt.sessions.replaceMessages(this.session.id, next.map((m) => original.get(m.id) ?? m));
    this.rt.sessions.archiveMessages(this.session.id, stored.filter((m) => !keep.has(m.id)));
    this.lastContextTokens = 0;
    const after = this.contextUsage().tokens;
    this.emit({ type: 'compaction', runId, beforeTokens: before, afterTokens: after });
    return { before, after };
  }

  /**
   * Compaction: summarizes everything before the most recent turns (`keepRecentTurns`, kept verbatim)
   * into one message. Long histories are summarized in chunks, each folding into the running summary.
   * The replaced messages are archived, so they stay readable and searchable.
   */
  async compact(runId = this.currentRunId, signal?: AbortSignal, focus?: string): Promise<{ before: number; after: number }> {
    const before = this.contextUsage().tokens;
    const model = this.rt.providers.resolve(this.session.model || undefined);
    const start = this.keptTail(model);
    const head = this.messages.slice(0, start);
    const tail = this.messages.slice(start);
    const lastUser = this.lastUserMessage();
    const summaryModel = this.rt.providers.resolve(this.rt.config.model.summary || this.session.model || undefined);
    const system =
      'You are summarizing a conversation between a user and an autonomous AI agent so the agent can continue seamlessly in a fresh context. ' +
      'Write a dense, structured summary with these sections: ## Goal (the user\'s overall objective and constraints), ## Progress (what has been done, ' +
      'decisions made and why), ## Key facts (file paths, commands, URLs, identifiers, errors and their fixes, user preferences), ## Current state ' +
      '(what is in progress, open problems), ## Next steps. Preserve exact names, paths and values. Do not invent anything.';
    if (this.rt.hooks.has('preCompact')) {
      const h = await this.rt.hooks.run('preCompact', { sessionId: this.session.id, messages: head.length, focus: focus ?? '' }, { cwd: this.session.cwd });
      if (h.context) focus = [focus, h.context].filter(Boolean).join('\n');
    }
    const chunks = this.transcriptChunks(head, 100_000);
    let summary = '';
    for (const [i, chunk] of chunks.entries()) {
      const prior = summary ? `<summary_so_far>\n${summary}\n</summary_so_far>\n\nThe transcript continues (part ${i + 1} of ${chunks.length}). Update the summary so it covers everything so far.\n\n` : '';
      const res = await this.rt.providers.chat(
        {
          model: summaryModel,
          system,
          messages: [
            {
              id: newId('m_'),
              role: 'user',
              parts: [{ type: 'text', text: `${focus ? `Focus especially on: ${focus}\n\n` : ''}${prior}<transcript>\n${chunk}\n</transcript>\n\nWrite the summary now.` }],
              createdAt: Date.now(),
            },
          ],
          tools: [],
          maxTokens: 8000,
          effort: 'low',
          thinking: false,
          showThinking: false,
          signal,
        },
        () => undefined,
        [],
      );
      summary = textOf(res.parts).trim() || summary || truncate(chunk, 8000);
    }
    // with no verbatim tail the latest request would be lost inside the summary: repeat it word for word
    const latest = !tail.length && lastUser ? truncate(messageText(lastUser), 6000) : '';
    // like Codex: the user's own words carry the requirements a summary tends to blur, so the
    // earlier user messages travel along verbatim, newest first, within a budget
    const kept = this.earlierUserMessages(head, Math.min(20_000, Math.floor(model.contextWindow * 0.08)), latest ? lastUser : undefined);
    const summaryMsg: Message = {
      id: newId('m_'),
      role: 'user',
      parts: [
        {
          type: 'text',
          text:
            `<conversation_summary>\nThe earlier conversation was compacted to save context. Summary:\n\n${summary}\n</conversation_summary>` +
            (kept.length ? `\n\nThe user's earlier messages, verbatim (oldest first):\n<earlier_user_messages>\n${kept.map((t) => `<message>\n${t}\n</message>`).join('\n')}\n</earlier_user_messages>` : '') +
            (latest ? `\n\nThe user's most recent request was:\n<latest_request>\n${latest}\n</latest_request>` : '') +
            (tail.length ? '\n\nThe most recent turns follow verbatim.' : '\n\nContinue from here.') +
            ' Re-read files before editing them; do not assume their earlier contents. Earlier details can be found with session_search.',
        },
      ],
      createdAt: Date.now(),
      meta: { kind: 'summary', archived: head.length },
    };
    const result = this.replaceHistory([summaryMsg, ...tail], runId, before);
    this.notice('info', `Context compacted: ~${before.toLocaleString()} → ~${result.after.toLocaleString()} tokens${tail.length ? ` (last ${this.rt.config.agent.compaction.keepRecentTurns === 1 ? 'turn' : 'turns'} kept verbatim)` : ''}.`);
    return result;
  }

  /**
   * Text of the user's messages in `messages` (including those an earlier compaction carried in its
   * summary), newest first until `budget` tokens, returned oldest first.
   */
  private earlierUserMessages(messages: Message[], budget: number, skip?: Message): string[] {
    const texts: string[] = [];
    for (const m of messages) {
      if (m.role !== 'user' || m === skip) continue;
      if (m.meta?.kind === 'summary') {
        const block = /<earlier_user_messages>([\s\S]*?)<\/earlier_user_messages>/.exec(messageText(m))?.[1] ?? '';
        for (const mm of block.matchAll(/<message>\n([\s\S]*?)\n<\/message>/g)) texts.push(mm[1] as string);
        continue;
      }
      const t = m.parts
        .filter((p): p is TextPart => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (t) texts.push(t);
    }
    const out: string[] = [];
    let left = budget;
    for (let i = texts.length - 1; i >= 0 && left > 200; i--) {
      const t = texts[i] as string;
      const cost = estimateTokens(t);
      if (cost <= left) {
        out.push(t);
        left -= cost;
      } else {
        out.push(`${truncate(t, left * 4)} [truncated]`);
        break;
      }
    }
    return out.reverse();
  }

  /** Last resort when no summary can be made: keep the recent turns and drop the rest (still archived). */
  private trimWithoutSummary(runId: string, reason: string): void {
    const before = this.contextUsage().tokens;
    const model = this.rt.providers.resolve(this.session.model || undefined);
    let start = this.keptTail(model);
    if (start >= this.messages.length) start = this.tailStart(1);
    if (start >= this.messages.length || start <= 0) {
      // even the current turn is too large: clear every tool output but the latest ones
      this.clearOldToolResults(2);
      this.notice('warn', `Context is nearly full and could not be summarized (${truncate(reason, 160)}).`);
      return;
    }
    const dropped = start;
    const note: Message = {
      id: newId('m_'),
      role: 'user',
      parts: [
        {
          type: 'text',
          text: `<conversation_summary>\nThe earlier conversation (${dropped} messages) was removed to free context; a summary could not be made (${truncate(reason, 200)}). Use session_search to look up earlier details, and re-read files before editing them.\n</conversation_summary>`,
        },
      ],
      createdAt: Date.now(),
      meta: { kind: 'summary', archived: dropped },
    };
    const result = this.replaceHistory([note, ...this.messages.slice(start)], runId, before);
    this.notice('warn', `Context was full and could not be summarized, so the oldest ${dropped} messages were set aside (~${before.toLocaleString()} → ~${result.after.toLocaleString()} tokens). They are still in the chat history.`);
  }

  /** The transcript as plain text, split into chunks of at most `maxChars` on message boundaries. */
  private transcriptChunks(messages: Message[], maxChars: number): string[] {
    const lines: string[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      for (const p of m.parts) {
        if (p.type === 'text' && p.text.trim()) lines.push(`${m.role.toUpperCase()}: ${p.text}`);
        else if (p.type === 'tool_call') lines.push(`ASSISTANT → ${p.name}(${truncate(JSON.stringify(p.input), 1000)})`);
        else if (p.type === 'tool_result') lines.push(`TOOL ${p.toolName}${p.isError ? ' (error)' : ''}: ${truncateMiddle(p.content, 4000).text}`);
        else if (p.type === 'file') lines.push(`USER attached ${p.name}`);
        else if (p.type === 'image') lines.push('USER attached an image');
      }
    }
    const chunks: string[] = [];
    let cur = '';
    for (const line of lines) {
      const l = line.length > maxChars ? truncateMiddle(line, maxChars).text : line;
      if (cur && cur.length + l.length + 2 > maxChars) {
        chunks.push(cur);
        cur = '';
      }
      cur += (cur ? '\n\n' : '') + l;
    }
    if (cur || !chunks.length) chunks.push(cur);
    // a pathological history is bounded: keep the first chunk (the original task) and the most recent ones
    return chunks.length > 8 ? [chunks[0] as string, ...chunks.slice(-7)] : chunks;
  }

  // ---------------------------------------------------------------------------
  // Undo / retry
  // ---------------------------------------------------------------------------

  /** Remove the last user turn (and everything after it) and restore files changed during it. */
  undo(): { removed: number; restoredFiles: string[]; text: string } | null {
    if (this.running) throw new Error('Cannot undo while running');
    let idx = -1;
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i] as Message;
      if (m.role === 'user' && m.meta?.kind !== 'summary') {
        idx = i;
        break;
      }
    }
    if (idx < 0) return null;
    const turn = this.messages.slice(0, idx).filter((m) => m.role === 'user' && m.meta?.kind !== 'summary').length;
    const text = messageText(this.messages[idx] as Message);
    const removed = this.messages.length - idx;
    this.messages = this.messages.slice(0, idx);
    this.contextEpoch += 1;
    this.rt.sessions.truncate(this.session.id, idx);
    const restoredFiles = this.rt.config.safety.checkpoints ? this.rt.checkpoints.restore(this.session.id, turn) : [];
    return { removed, restoredFiles, text };
  }

  /** Keeps a message that cannot be answered yet (no provider connected), flagged so clients can offer to answer it later. */
  private holdUnanswered(inp: UserInput): void {
    const parts: Part[] = [];
    if (inp.text) parts.push({ type: 'text', text: inp.text });
    for (const f of inp.files ?? []) parts.push(f);
    for (const img of inp.images ?? []) parts.push(img);
    if (!parts.length) return;
    const msg: Message = { id: newId('m_'), role: 'user', parts, createdAt: Date.now(), meta: { ...inp.meta, unanswered: 'no_provider' } };
    this.append([msg]);
    this.emit({ type: 'message', runId: '', message: msg });
  }

  /** The last message, if it is still waiting for a provider to be connected. */
  heldMessage(): Message | undefined {
    const last = this.messages.at(-1);
    return last?.role === 'user' && last.meta?.unanswered === 'no_provider' ? last : undefined;
  }

  /** Answers a message that arrived before any provider was connected. */
  async answerHeld(opts: AgentRunOptions = {}): Promise<AgentRunResult | null> {
    if (this.running) throw new Error('This agent is already running. Interrupt it or wait for it to finish.');
    const held = this.heldMessage();
    if (!held) return null;
    const ready = this.rt.providers.readiness(opts.model ?? (this.session.model && !this.session.model.startsWith('kronos:') ? this.session.model : undefined));
    if (!ready.ok) {
      const error = new NotConnectedError(ready.provider).message;
      this.notice('error', error, 'no_provider');
      return { runId: '', text: '', stopReason: 'error', usage: emptyUsage(), durationMs: 0, error, toolCalls: 0 };
    }
    // replace the held message with a real turn carrying the same content
    this.messages = this.messages.slice(0, -1);
    this.contextEpoch += 1;
    this.rt.sessions.truncate(this.session.id, this.messages.length);
    const { unanswered: _held, ...meta } = held.meta ?? {};
    return this.run(
      {
        text: held.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(''),
        files: held.parts.filter((p) => p.type === 'file') as UserInput['files'],
        images: held.parts.filter((p) => p.type === 'image') as UserInput['images'],
        meta: Object.keys(meta).length ? meta : undefined,
      },
      opts,
    );
  }

  async retry(opts: AgentRunOptions = {}): Promise<AgentRunResult | null> {
    const u = this.undo();
    if (!u) return null;
    return this.run({ text: u.text }, opts);
  }

  // ---------------------------------------------------------------------------
  // Delegation
  // ---------------------------------------------------------------------------

  async delegate(
    tasks: DelegateTask[],
    opts: { context?: string; signal?: AbortSignal; parentToolCallId?: string; onBoard?: (board: TeamBoard) => void } = {},
  ): Promise<DelegateResult[]> {
    const cfg = this.rt.config.agent.subagents;
    if (this.depth >= cfg.maxDepth) throw new Error(`Maximum delegation depth (${cfg.maxDepth}) reached — do this work yourself.`);
    const defs = this.rt.agentDefinitions(this.session.cwd);
    const defOf = (t: DelegateTask) => defs.find((d) => d.name === (t.agent ?? 'general')) ?? defs.find((d) => d.name === 'general');
    // unique labels: they are the members' names on the board and in the UI
    const labels: string[] = [];
    for (const [i, t] of tasks.entries()) {
      const base = t.label?.trim() || `${defOf(t)?.name ?? 'agent'} ${i + 1}`;
      labels.push(labels.includes(base) ? `${base} (${i + 1})` : base);
    }
    // two or more agents form a team that coordinates through a shared board
    const board = tasks.length > 1 ? new TeamBoard(labels) : undefined;
    const agentIds = labels.map(() => newId('sub_'));
    if (board) {
      tasks.forEach((t, i) => board.add(truncate(t.task.split('\n')[0] ?? t.task, 120), labels[i]));
      board.onPost = (p) => {
        const i = labels.indexOf(p.author);
        if (i >= 0) this.emit({ type: 'subagent', runId: this.currentRunId, agentId: agentIds[i] as string, label: p.author, status: 'running', detail: `📌 ${truncate(p.text, 160)}` });
      };
      opts.onBoard?.(board);
    }
    return mapLimit(tasks, Math.max(1, cfg.maxConcurrent), async (t, i) => {
      const def = defOf(t);
      const label = labels[i] as string;
      const agentId = agentIds[i] as string;
      const started = Date.now();
      const modelRef = t.model ?? def?.model ?? this.rt.config.model.subagent ?? (this.session.model || undefined);
      const session = this.rt.sessions.create({
        title: `↳ ${label}`,
        parentId: this.session.id,
        cwd: this.session.cwd,
        source: 'subagent',
        profile: this.session.profile,
        model: this.rt.providers.resolve(modelRef).ref,
        mode: this.mode,
      });
      const only = t.toolsets?.length ? t.toolsets : def?.tools;
      const child = this.rt.createAgent({
        session,
        surface: 'subagent',
        depth: this.depth + 1,
        definition: def,
        subagentContext: opts.context,
        onPermission: this.opts.onPermission
          ? (req) => this.opts.onPermission!({ ...req, summary: `[${label}] ${req.summary}` })
          : undefined,
        autoApprove: this.opts.autoApprove,
        toolFilter: only ? { only: [...only, 'todo_write', 'skill_view', 'skills_list', 'memory', ...(board ? ['team_board'] : [])] } : undefined,
        team: board ? { board, member: label } : undefined,
      });
      this.emit({ type: 'subagent', runId: this.currentRunId, agentId, label, status: 'start', detail: truncate(t.task, 200) });
      const off = child.events.on((e) => {
        if (e.type === 'tool_call') this.emit({ type: 'subagent', runId: this.currentRunId, agentId, label, status: 'running', detail: e.summary });
      });
      try {
        const r = await child.run({ text: t.task }, { signal: opts.signal, maxIterations: cfg.maxIterations });
        const ok = r.stopReason !== 'error' && r.stopReason !== 'interrupted' && r.stopReason !== 'stalled';
        this.emit({ type: 'subagent', runId: this.currentRunId, agentId, label, status: ok ? 'done' : 'error', detail: r.error });
        return { label, ok, text: r.text, error: r.error, sessionId: session.id, durationMs: Date.now() - started, usage: r.usage };
      } catch (e) {
        this.emit({ type: 'subagent', runId: this.currentRunId, agentId, label, status: 'error', detail: errorMessage(e) });
        return { label, ok: false, text: '', error: errorMessage(e), sessionId: session.id, durationMs: Date.now() - started, usage: emptyUsage() };
      } finally {
        off();
        this.rt.releaseAgent(session.id);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Background agents (Codex spawn_agent / wait_agent / send_input / close_agent)
  // ---------------------------------------------------------------------------

  /** Start a subagent that works in the background; returns at once. */
  spawnAgent(t: DelegateTask & { context?: string }): BackgroundAgent {
    const cfg = this.rt.config.agent.subagents;
    if (this.depth >= cfg.maxDepth) throw new Error(`Maximum delegation depth (${cfg.maxDepth}) reached — do this work yourself.`);
    const running = [...this.bgAgents.values()].filter((a) => a.status === 'running').length;
    if (running >= Math.max(1, cfg.maxConcurrent)) throw new Error(`${running} background agents are already running (agent.subagents.maxConcurrent); wait for one or stop one first.`);
    const defs = this.rt.agentDefinitions(this.session.cwd);
    const def = defs.find((d) => d.name === (t.agent ?? 'general')) ?? defs.find((d) => d.name === 'general');
    const id = `a${this.bgAgents.size + 1}`;
    const label = t.label?.trim() || `${def?.name ?? 'agent'} ${id}`;
    const modelRef = t.model ?? def?.model ?? this.rt.config.model.subagent ?? (this.session.model || undefined);
    const session = this.rt.sessions.create({ title: `↳ ${label}`, parentId: this.session.id, cwd: this.session.cwd, source: 'subagent', profile: this.session.profile, model: this.rt.providers.resolve(modelRef).ref, mode: this.mode });
    const only = t.toolsets?.length ? t.toolsets : def?.tools;
    const child = this.rt.createAgent({
      session,
      surface: 'subagent',
      depth: this.depth + 1,
      definition: def,
      subagentContext: t.context,
      onPermission: this.opts.onPermission ? (req) => this.opts.onPermission!({ ...req, summary: `[${label}] ${req.summary}` }) : undefined,
      autoApprove: this.opts.autoApprove,
      toolFilter: only ? { only: [...only, 'todo_write', 'skill_view', 'skills_list', 'memory'] } : undefined,
    });
    const entry = { id, label, sessionId: session.id, status: 'running', startedAt: Date.now(), reported: false, child, controller: new AbortController() } as BackgroundAgent;
    entry.done = this.runBackground(entry, t.task);
    this.bgAgents.set(id, entry);
    this.bgNudged = false;
    return entry;
  }

  private runBackground(entry: BackgroundAgent, task: string): Promise<void> {
    entry.status = 'running';
    entry.reported = false;
    this.emit({ type: 'subagent', runId: this.currentRunId, agentId: entry.sessionId, label: entry.label, status: 'start', detail: truncate(task, 200) });
    const off = entry.child.events.on((e) => {
      if (e.type === 'tool_call') this.emit({ type: 'subagent', runId: this.currentRunId, agentId: entry.sessionId, label: entry.label, status: 'running', detail: e.summary });
    });
    return entry.child
      .run({ text: task }, { signal: entry.controller.signal, maxIterations: this.rt.config.agent.subagents.maxIterations })
      .then((r) => {
        const ok = r.stopReason !== 'error' && r.stopReason !== 'stalled' && r.stopReason !== 'interrupted';
        entry.status = entry.status === 'stopped' ? 'stopped' : ok ? 'done' : 'failed';
        entry.result = r.text;
        entry.error = r.error;
      })
      .catch((e) => {
        entry.status = 'failed';
        entry.error = errorMessage(e);
      })
      .finally(() => {
        entry.finishedAt = Date.now();
        off();
        this.emit({ type: 'subagent', runId: this.currentRunId, agentId: entry.sessionId, label: entry.label, status: entry.status === 'done' ? 'done' : 'error', detail: entry.error });
      });
  }

  backgroundAgents(): BackgroundAgent[] {
    return [...this.bgAgents.values()];
  }

  /** Wait until the given (default: all running) agents finish or `timeoutMs` passes. */
  async waitAgents(ids: string[] | undefined, timeoutMs: number, signal?: AbortSignal): Promise<BackgroundAgent[]> {
    const targets = (ids?.length ? ids.map((i) => this.bgAgents.get(i)).filter((a): a is BackgroundAgent => !!a) : [...this.bgAgents.values()].filter((a) => a.status === 'running' || !a.reported));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)));
    const aborted = new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));
    await Promise.race([Promise.all(targets.map((a) => a.done)), timeout, aborted]);
    if (timer) clearTimeout(timer);
    return targets;
  }

  /** Give a finished background agent a follow-up task (it keeps its context). */
  sendToAgent(id: string, message: string): BackgroundAgent {
    const a = this.bgAgents.get(id);
    if (!a) throw new Error(`No background agent ${id}`);
    if (a.status === 'running') throw new Error(`${id} is still working; wait for it first.`);
    a.controller = new AbortController();
    a.done = this.runBackground(a, message);
    this.bgNudged = false;
    return a;
  }

  stopAgent(id: string): boolean {
    const a = this.bgAgents.get(id);
    if (!a || a.status !== 'running') return false;
    a.status = 'stopped';
    a.reported = true;
    a.controller.abort();
    a.child.interrupt();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Titles
  // ---------------------------------------------------------------------------

  private async autoTitle(): Promise<void> {
    const firstUser = this.messages.find((m) => m.role === 'user' && m.meta?.kind !== 'summary');
    if (!firstUser) return;
    const firstText = messageText(firstUser).trim();
    if (!firstText) return;
    let title = '';
    try {
      const ref = this.rt.config.model.summary || this.rt.providers.smallModelRef(this.session.model || this.rt.providers.resolve().ref);
      const res = await this.rt.providers.chat(
        {
          model: this.rt.providers.resolve(ref),
          system: 'You write concise titles for conversations. Reply with a title of 2-6 words in the language of the conversation. No quotes, no trailing punctuation.',
          messages: [{ id: 'x', role: 'user', parts: [{ type: 'text', text: truncate(firstText, 2000) }], createdAt: Date.now() }],
          tools: [],
          maxTokens: 64,
          effort: 'low',
          thinking: false,
          showThinking: false,
        },
        () => undefined,
        [],
      );
      title = textOf(res.parts).trim().replace(/^["'#\s]+|["'.\s]+$/g, '').split('\n')[0] ?? '';
    } catch (e) {
      log.debug('auto title failed', e);
    }
    if (!title) title = truncate(firstText.replace(/\s+/g, ' '), 48);
    title = truncate(title, 80);
    this.saveSession({ title });
    this.rt.artifacts.renameSession(this.session.id, title);
    this.emit({ type: 'title', runId: this.currentRunId, sessionId: this.session.id, title });
  }

  // ---------------------------------------------------------------------------
  // Learning review (agent.nudges.learning: background)
  // ---------------------------------------------------------------------------

  /** A separate agent reads the turn and updates memory and skills; the conversation is untouched. */
  private async learningReview(): Promise<void> {
    const session = this.rt.sessions.create({ title: '↳ Learning review', parentId: this.session.id, cwd: this.session.cwd, source: 'subagent', profile: this.session.profile, model: this.session.model, mode: 'yolo' });
    const reviewer = this.rt.createAgent({ session, surface: 'subagent', depth: 1, definition: LEARNING_REVIEWER, autoApprove: true, toolFilter: { only: LEARNING_REVIEWER.tools } });
    const changes: string[] = [];
    const off = reviewer.events.on((e) => {
      if (e.type === 'tool_call' && (e.name === 'memory' || e.name === 'skill_manage') && !/^(view|list|read)/.test(String((e.input as { action?: string }).action ?? ''))) changes.push(e.summary);
    });
    try {
      const recent = this.messages.slice(-40);
      const used = [...this.runSkills];
      await reviewer.run(
        {
          text: `Conversation to review${used.length ? ` (skills used: ${used.join(', ')})` : ''}:\n\n${recapTranscript(recent, 40_000)}\n\nUpdate memory and skills if this conversation warrants it.`,
        },
        { maxIterations: 12 },
      );
      if (changes.length) this.notice('info', `Learned from this conversation: ${truncate(changes.join(' · '), 300)}`);
    } finally {
      off();
      this.rt.releaseAgent(session.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Automatic memory extraction (memory.autoExtract)
  // ---------------------------------------------------------------------------

  /** After a run, let a small model pick out durable facts the agent didn't save itself. */
  private async extractMemories(reply: string): Promise<void> {
    const lastUser = [...this.messages].reverse().find((m) => m.role === 'user' && m.meta?.kind !== 'summary' && messageText(m).trim());
    const userText = lastUser ? messageText(lastUser).trim() : '';
    if (userText.length < 12) return;
    const memory = this.rt.memory;
    const known = [...memory.entries('user').map((e) => `USER: ${e}`), ...memory.entries('memory').map((e) => `MEMORY: ${e}`)];
    let raw = '';
    try {
      const ref = this.rt.config.model.summary || this.rt.providers.smallModelRef(this.session.model || this.rt.providers.resolve().ref);
      const res = await this.rt.providers.chat(
        {
          model: this.rt.providers.resolve(ref),
          system: [
            'You extract durable facts worth remembering across future conversations.',
            'Return only JSON: {"user": [...], "memory": [...]}.',
            '"user": stable facts about the user (name, role, preferences, recurring goals, people, tools they use).',
            '"memory": lasting facts about their environment, projects or conventions learned in this exchange.',
            'Skip anything temporary, sensitive (passwords, keys, health, finances unless explicitly asked to remember), already known, or speculative.',
            'Each fact is one short sentence. Usually there is nothing new: return {"user": [], "memory": []}.',
          ].join('\n'),
          messages: [
            {
              id: 'x',
              role: 'user',
              parts: [{ type: 'text', text: `Already known:\n${known.join('\n') || '(nothing)'}\n\nUser said:\n${truncate(userText, 3000)}\n\nAssistant replied:\n${truncate(reply, 2000)}` }],
              createdAt: Date.now(),
            },
          ],
          tools: [],
          maxTokens: 400,
          effort: 'low',
          thinking: false,
          showThinking: false,
        },
        () => undefined,
        [],
      );
      raw = textOf(res.parts);
    } catch (e) {
      log.debug('memory extraction failed', e);
      return;
    }
    let parsed: { user?: unknown; memory?: unknown } = {};
    try {
      parsed = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '{}') as typeof parsed;
    } catch {
      return;
    }
    const saved: string[] = [];
    for (const target of ['user', 'memory'] as const) {
      const facts = Array.isArray(parsed[target]) ? (parsed[target] as unknown[]).filter((f): f is string => typeof f === 'string') : [];
      for (const fact of facts.slice(0, 3)) {
        const clean = fact.trim().slice(0, 300);
        if (clean && memory.add(target, clean, this.session.id).ok) saved.push(clean);
      }
    }
    if (saved.length) this.notice('info', `Remembered: ${saved.join(' · ')}`);
  }

  rename(title: string): void {
    this.saveSession({ title });
    this.rt.artifacts.renameSession(this.session.id, title);
    this.emit({ type: 'title', runId: this.currentRunId, sessionId: this.session.id, title });
  }
}

export { primaryArg };

/** Instructions injected when Codemaster is switched on (max effort + a rigorous workflow). */
/** Which per-run limit was reached, as a short description; '' while within budget. */
export function overBudget(budget: { maxTokens: number; maxCostUsd: number; maxMinutes: number } | undefined, usage: Usage, startedAt: number, now = Date.now()): string {
  if (!budget) return '';
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (budget.maxTokens > 0 && tokens >= budget.maxTokens) return `${tokens.toLocaleString()} of ${budget.maxTokens.toLocaleString()} tokens`;
  if (budget.maxCostUsd > 0 && (usage.costUsd ?? 0) >= budget.maxCostUsd) return `$${(usage.costUsd ?? 0).toFixed(2)} of $${budget.maxCostUsd.toFixed(2)}`;
  if (budget.maxMinutes > 0 && now - startedAt >= budget.maxMinutes * 60_000) return `${budget.maxMinutes} min`;
  return '';
}

export function codemasterDirective(toolNames: string[]): string {
  const has = (n: string) => toolNames.includes(n);
  const steps = [
    'Gather information before effort: read the relevant code, configs, docs and existing tests, and note the project checks listed in the environment. What you know about the task moves the result more than how long you work on it. Ask only if genuinely blocked.',
    has('todo_write')
      ? 'Plan with todo_write: concrete, verifiable steps, and write down up front what "done" means — which checks must pass and what behaviour must be observable.'
      : 'Plan: list concrete, verifiable steps and state up front which checks must pass for the work to count as done.',
    `For any decision that is not obvious (design, root cause, approach): propose two or three candidates, probe them cheaply side by side${
      has('delegate') ? ' (a quick spike, a failing test, a measurement — in parallel via delegate when they are independent; delegated agents coordinate through a shared team board)' : ' (a quick spike, a failing test, a measurement)'
    }, then compose the approach the evidence supports. Do not commit to the first idea untested.`,
    'Implement in small, coherent steps that match the existing style; prefer root-cause fixes over workarounds.',
    has('verify')
      ? 'Verify with the verify tool after each meaningful change and before finishing; reproduce bugs as failing checks before fixing them. Never claim success that a check has not shown.'
      : 'Verify with evidence: run the relevant tests, type-checks, linters and builds; reproduce bugs before fixing them; never claim success you have not observed.',
    has('delegate')
      ? 'Review before finishing: delegate a reviewer subagent to critique the full diff for bugs, edge cases, security and missing tests, then fix every finding that holds up and verify again.'
      : 'Review before finishing: re-read the full diff adversarially for bugs, edge cases, security and missing tests, fix what you find and verify again.',
    has('skill_manage') ? 'Learn: if a reusable procedure emerged, capture it or fix the skill you used (skill_manage) — general steps only, no task-specific values.' : '',
    'Report: what changed and why, how it was verified (commands and results), and any remaining risks or follow-ups.',
  ].filter(Boolean);
  return `CODEMASTER MODE is on. The user wants the most thorough, highest-quality result and accepts extra time and cost. Work like a principal engineer:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
}
