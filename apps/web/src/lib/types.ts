// UI-side mirrors of the @kronos/core data model (kept dependency-free for the browser bundle).

export type PermissionMode = 'ask' | 'auto-edit' | 'yolo' | 'plan';

export interface ImagePart {
  type: 'image';
  mediaType: string;
  data: string;
  name?: string;
}
export interface FilePart {
  type: 'file';
  name: string;
  mediaType: string;
  path?: string;
  text?: string;
  size?: number;
}
export type Part =
  | { type: 'text'; text: string }
  | ImagePart
  | FilePart
  | { type: 'thinking'; text: string; signature?: string; redactedData?: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; toolName: string; content: string; images?: ImagePart[]; isError?: boolean; meta?: ToolMeta }
  | { type: 'raw'; provider: string; block: unknown };

export interface ToolMeta {
  diff?: string;
  path?: string;
  durationMs?: number;
  todos?: Todo[];
  added?: number;
  removed?: number;
  [k: string]: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  parts: Part[];
  createdAt: number;
  model?: string;
  usage?: Usage;
  meta?: { kind?: string; interrupted?: boolean; [k: string]: unknown };
}

export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  activeForm?: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  profile: string;
  cwd: string;
  project: string;
  model: string;
  source: string;
  pinned: boolean;
  archived: boolean;
  parentId?: string;
  mode: PermissionMode;
  usage: Usage;
  messageCount: number;
  meta: Record<string, unknown>;
}

export interface ModelInfo {
  ref: string;
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  pricing?: { input: number; output: number };
  vision?: boolean;
  description?: string;
  tags?: string[];
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  risk: string;
  reason: string;
  dangerous?: boolean;
}

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
  | { type: 'tool_result'; runId: string; id: string; name: string; content: string; isError: boolean; durationMs: number; meta?: ToolMeta; images?: ImagePart[] }
  | { type: 'permission_request'; runId: string; request: PermissionRequest }
  | { type: 'permission_resolved'; runId: string; requestId: string; decision: string }
  | { type: 'clarify_request'; runId: string; request: ClarifyRequest }
  | { type: 'clarify_resolved'; runId: string; requestId: string; answer: string }
  | { type: 'message'; runId: string; message: Message }
  | { type: 'usage'; runId: string; usage: Usage; total: Usage; contextTokens: number; contextWindow: number }
  | { type: 'compaction'; runId: string; beforeTokens: number; afterTokens: number }
  | { type: 'todos'; runId: string; todos: Todo[] }
  | { type: 'subagent'; runId: string; agentId: string; label: string; status: 'start' | 'running' | 'done' | 'error'; detail?: string }
  | { type: 'artifact'; runId: string; artifact: { id: string; kind: string; title: string; location: string } }
  | { type: 'notice'; runId: string; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'title'; runId: string; sessionId: string; title: string }
  | { type: 'run_end'; runId: string; stopReason: string; text: string; usage: Usage; durationMs: number; error?: string };

export interface RunningInfo {
  sessionId: string;
  title: string;
  startedAt: number;
  runId: string;
  source: string;
}

export interface Status {
  version: string;
  profile: string;
  profiles: string[];
  home: string;
  cwd: string;
  model: ModelInfo;
  demo: boolean;
  agentName: string;
  running: RunningInfo[];
  pending: { permissions: PermissionRequest[]; clarify: ClarifyRequest[] };
  sessionStore: string;
  platforms: PlatformStatus[];
  mcp: McpStatus[];
  cron: { jobs: number; enabled: boolean; next: number | null };
  gateway: { url: string; openaiApi: boolean; auth: boolean };
  platform: string;
}

export interface PlatformStatus {
  id: string;
  label: string;
  state: 'disabled' | 'stopped' | 'starting' | 'running' | 'error';
  detail?: string;
  botName?: string;
  configured: boolean;
  enabled: boolean;
  messages: number;
}

export interface McpStatus {
  name: string;
  transport: string;
  status: 'connecting' | 'connected' | 'error' | 'disabled';
  error?: string;
  tools: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  category: string;
  tags: string[];
  version?: string;
  source: string;
  path: string;
  dir: string;
  enabled: boolean;
  editable: boolean;
  files: string[];
  uses?: number;
}

export interface ToolsetStatus {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  available: boolean;
  reason?: string;
  tools: { name: string; description: string; available: boolean; reason?: string }[];
}

export interface Artifact {
  id: string;
  kind: 'file' | 'image' | 'link';
  title: string;
  location: string;
  sessionId?: string;
  sessionTitle?: string;
  createdAt: number;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  description: string;
  prompt: string;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: 'ok' | 'error' | 'running';
  lastOutput?: string;
  lastSessionId?: string;
  runCount: number;
  deliver?: { target?: string };
  model?: string;
  running?: boolean;
}

export interface CronRun {
  jobId: string;
  name: string;
  startedAt: number;
  finishedAt: number;
  status: 'ok' | 'error';
  output: string;
  sessionId?: string;
}
