import type { JSONSchema, ToolOutput, ToolRisk } from '../types.js';
import type { Kronos } from '../runtime.js';
import type { Agent } from '../agent/agent.js';

export interface ToolContext {
  runtime: Kronos;
  agent: Agent;
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  toolCallId: string;
  /** index of the current user turn (used for checkpoints) */
  turn: number;
  progress(text: string): void;
  askUser(question: string, options?: string[]): Promise<string>;
  /** snapshot a file before modifying it (checkpoints for /undo) */
  checkpoint(path: string): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<I extends Record<string, any> = Record<string, any>> {
  name: string;
  description: string;
  parameters: JSONSchema;
  toolset: string;
  risk: ToolRisk | ((input: I) => ToolRisk);
  /** may run concurrently with other parallel-safe calls in the same turn */
  parallelSafe?: boolean;
  /** returns a reason string when the tool cannot be used right now (missing key/binary) */
  available?: (rt: Kronos) => string | null;
  /** human friendly one-liner shown in "product" tool display */
  summarize?: (input: I) => string;
  execute(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolsetInfo {
  id: string;
  label: string;
  description: string;
}

export const TOOLSETS: ToolsetInfo[] = [
  { id: 'files', label: 'Files', description: 'Read, write, edit, patch and search the workspace.' },
  { id: 'shell', label: 'Shell', description: 'Run commands in a sandboxable terminal, manage background processes.' },
  { id: 'code', label: 'Code execution', description: 'Execute Python, JavaScript or Bash snippets.' },
  { id: 'web', label: 'Web', description: 'Search the web and fetch pages as markdown.' },
  { id: 'browser', label: 'Browser', description: 'Drive a headless browser: navigate, click, type, screenshot.' },
  { id: 'memory', label: 'Memory', description: 'Persist and recall long-term memories and the user profile.' },
  { id: 'sessions', label: 'Session search', description: 'Full-text search across every past conversation.' },
  { id: 'todo', label: 'Planning', description: 'Track multi-step work with a live todo list.' },
  { id: 'clarify', label: 'Clarify', description: 'Ask the user a question when genuinely blocked.' },
  { id: 'delegate', label: 'Subagents', description: 'Delegate work to parallel subagents with their own context.' },
  { id: 'skills', label: 'Skills', description: 'Load, create and improve reusable skills (procedural memory).' },
  { id: 'cron', label: 'Automations', description: 'Schedule recurring or one-off autonomous tasks.' },
  { id: 'image', label: 'Image', description: 'Generate images from text prompts.' },
  { id: 'vision', label: 'Vision', description: 'Look at images and screenshots.' },
  { id: 'voice', label: 'Voice', description: 'Text-to-speech audio generation.' },
  { id: 'artifacts', label: 'Artifacts', description: 'Register files, images and links as artifacts.' },
  { id: 'messaging', label: 'Messaging', description: 'Send messages to Telegram, Discord, Slack and other platforms.' },
  { id: 'http', label: 'HTTP', description: 'Call REST/GraphQL APIs.' },
  { id: 'mcp', label: 'MCP', description: 'Tools from connected Model Context Protocol servers.' },
  { id: 'github', label: 'GitHub', description: 'Clone repositories, push branches, open pull requests, read and answer issues.' },
  { id: 'review', label: 'Code review', description: 'Review changes with parallel reviewers, verified findings and inline pull request comments.' },
];

export function resolveRisk<I extends Record<string, unknown>>(def: ToolDefinition<I>, input: I): ToolRisk {
  return typeof def.risk === 'function' ? def.risk(input) : def.risk;
}
