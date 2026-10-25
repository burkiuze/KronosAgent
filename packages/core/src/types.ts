/**
 * Provider-neutral data model shared by every Kronos surface
 * (core runtime, gateway, CLI, desktop UI).
 */

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  mediaType: string;
  /** base64 payload (no data: prefix) */
  data: string;
  name?: string;
}

/** A file attached by the user. Text files are inlined, binary files referenced by path. */
export interface FilePart {
  type: 'file';
  name: string;
  mediaType: string;
  path?: string;
  text?: string;
  size?: number;
}

export interface ThinkingPart {
  type: 'thinking';
  text: string;
  /** Opaque provider signature that must be replayed unchanged. */
  signature?: string;
  /** Redacted thinking payload (Anthropic `redacted_thinking`). */
  redactedData?: string;
  provider?: string;
  model?: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  content: string;
  images?: ImagePart[];
  isError?: boolean;
  meta?: ToolResultMeta;
}

/** Provider specific block that must be replayed verbatim to the same provider (fallback, compaction, ...). */
export interface RawPart {
  type: 'raw';
  provider: string;
  model?: string;
  block: unknown;
}

export type Part = TextPart | ImagePart | FilePart | ThinkingPart | ToolCallPart | ToolResultPart | RawPart;

export interface Message {
  id: string;
  role: Role;
  parts: Part[];
  createdAt: number;
  /** model reference ("provider:model") that produced an assistant message */
  model?: string;
  usage?: Usage;
  stopReason?: StopReason;
  meta?: MessageMeta;
}

export interface MessageMeta {
  /** compaction summary, synthetic notices, slash-command expansions, ... */
  /** notice = shown to the user; note = instruction for the model only (hidden in UIs) */
  kind?: 'summary' | 'notice' | 'note' | 'command' | 'skill' | 'cron' | 'subagent' | 'platform';
  interrupted?: boolean;
  source?: string;
  author?: string;
  [key: string]: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  costUsd?: number;
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'pause_turn'
  | 'stop_sequence'
  | 'context_window'
  | 'interrupted'
  | 'max_iterations'
  /** the watchdog ended a run that kept repeating a failing action */
  | 'stalled'
  /** the run reached agent.budget (tokens, cost or time) */
  | 'budget'
  | 'error';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Configurable effort: a provider effort level, or Codemaster (max effort + a rigorous plan/verify/review workflow). */
export type EffortSetting = Effort | 'codemaster';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface JSONSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  [key: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

/** How dangerous a tool is; drives the permission system. */
export type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'external';

export interface ArtifactRef {
  kind: 'file' | 'image' | 'link';
  title: string;
  location: string;
}

export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  activeForm?: string;
}

export interface ToolResultMeta {
  diff?: string;
  path?: string;
  paths?: string[];
  artifacts?: ArtifactRef[];
  exitCode?: number | null;
  durationMs?: number;
  truncated?: boolean;
  fullOutputPath?: string;
  todos?: Todo[];
  url?: string;
  /** the body was dropped from the model context to save room (the stored session keeps it) */
  cleared?: boolean;
  [key: string]: unknown;
}

export interface ToolOutput {
  content: string;
  images?: ImagePart[];
  isError?: boolean;
  meta?: ToolResultMeta;
}

// ---------------------------------------------------------------------------
// Models / providers
// ---------------------------------------------------------------------------

export type ReasoningStyle = 'adaptive' | 'budget' | 'openai' | 'none';

export interface ModelInfo {
  /** canonical reference "provider:model-id" */
  ref: string;
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  /** USD per million tokens */
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  vision?: boolean;
  tools?: boolean;
  reasoning?: ReasoningStyle;
  defaultEffort?: Effort;
  /** supports mid-conversation `role: system` messages */
  systemMessages?: boolean;
  /** Anthropic server-side refusal fallbacks */
  serverFallbacks?: boolean;
  /** model rejects sampling params (temperature/top_p) */
  noSampling?: boolean;
  description?: string;
  tags?: string[];
}

export interface ChatRequest {
  model: ModelInfo;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  effort?: Effort;
  thinking?: boolean;
  showThinking?: boolean;
  temperature?: number;
  signal?: AbortSignal;
  sessionId?: string;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; partialJson: string }
  | { type: 'notice'; level: 'info' | 'warn'; text: string }
  /** the request is being retried or moved to a fallback: discard what this attempt streamed */
  | { type: 'restart' };

export interface ChatResponse {
  parts: Part[];
  stopReason: StopReason;
  usage: Usage;
  /** model that actually served the request (may differ after a fallback) */
  model: string;
  refusal?: { category?: string | null; explanation?: string | null };
}

export interface Provider {
  readonly id: string;
  chat(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResponse>;
  listModels?(): Promise<ModelInfo[]>;
}

// ---------------------------------------------------------------------------
// Agent events (streamed to every UI)
// ---------------------------------------------------------------------------

export type PermissionMode = 'ask' | 'auto-edit' | 'yolo' | 'plan';

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  risk: ToolRisk;
  reason: string;
  dangerous?: boolean;
}

export type PermissionDecision =
  | { decision: 'allow' }
  | { decision: 'allow_session' }
  | { decision: 'allow_always' }
  | { decision: 'deny'; feedback?: string };

export interface ClarifyRequest {
  requestId: string;
  sessionId: string;
  question: string;
  options?: string[];
}

export type AgentEvent =
  | { type: 'run_start'; runId: string; sessionId: string; model: string }
  | { type: 'turn_start'; runId: string; iteration: number }
  | { type: 'text_delta'; runId: string; text: string }
  | { type: 'thinking_delta'; runId: string; text: string }
  | { type: 'tool_call_start'; runId: string; id: string; name: string }
  | { type: 'tool_call_delta'; runId: string; id: string; partialJson: string }
  | { type: 'tool_call'; runId: string; id: string; name: string; input: Record<string, unknown>; summary: string; toolset: string }
  | { type: 'tool_progress'; runId: string; id: string; text: string }
  | { type: 'tool_result'; runId: string; id: string; name: string; content: string; isError: boolean; durationMs: number; meta?: ToolResultMeta; images?: ImagePart[] }
  | { type: 'permission_request'; runId: string; request: PermissionRequest }
  | { type: 'permission_resolved'; runId: string; requestId: string; decision: PermissionDecision['decision'] }
  | { type: 'clarify_request'; runId: string; request: ClarifyRequest }
  | { type: 'clarify_resolved'; runId: string; requestId: string; answer: string }
  | { type: 'message'; runId: string; message: Message }
  | { type: 'usage'; runId: string; usage: Usage; total: Usage; contextTokens: number; contextWindow: number }
  | { type: 'compaction'; runId: string; beforeTokens: number; afterTokens: number }
  | { type: 'todos'; runId: string; todos: Todo[] }
  | { type: 'subagent'; runId: string; agentId: string; label: string; status: 'start' | 'running' | 'done' | 'error'; detail?: string }
  | { type: 'artifact'; runId: string; artifact: ArtifactRef & { id: string } }
  /** code: machine-readable reason, e.g. `no_provider` when no model provider is connected */
  | { type: 'notice'; runId: string; level: 'info' | 'warn' | 'error'; text: string; code?: string }
  | { type: 'title'; runId: string; sessionId: string; title: string }
  | { type: 'run_end'; runId: string; stopReason: StopReason; text: string; usage: Usage; durationMs: number; error?: string };

export type AgentEventType = AgentEvent['type'];

export interface UserInput {
  text: string;
  images?: ImagePart[];
  files?: FilePart[];
  meta?: MessageMeta;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 };
}

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: a.cacheWriteTokens + (b.cacheWriteTokens ?? 0),
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

export function messageText(m: Message): string {
  return m.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}
