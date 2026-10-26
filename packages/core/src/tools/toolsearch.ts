import type { Kronos } from '../runtime.js';
import type { ToolDefinition } from './types.js';
import { Bm25Index } from '../util/bm25.js';
import { describeArgs } from '../providers/toolcalls.js';

/** MCP tools that are not sent up front: all of them in lean mode, or when there are too many. */
export function deferredTools(rt: Kronos, lean = false): ToolDefinition[] {
  const limit = rt.config.mcp.deferAfter ?? 30;
  const mcp = rt.tools.all().filter((t) => t.toolset === 'mcp' && t.name !== 'tool_search');
  return lean || (limit > 0 && mcp.length > limit) ? mcp : [];
}

/**
 * Progressive disclosure for large tool sets (Codex `tool_search`, Hermes tool_search): the model
 * searches the deferred MCP tools by what it needs, and the matches become callable from its next
 * step on. Keeps dozens of tool schemas out of every request.
 */
export const toolSearchTool: ToolDefinition<{ query: string; limit?: number }> = {
  name: 'tool_search',
  toolset: 'mcp',
  risk: 'read',
  parallelSafe: true,
  available: (rt) => (rt.tools.all().some((t) => t.toolset === 'mcp' && t.name !== 'tool_search') ? null : 'no MCP tools'),
  description:
    'Find and load tools from connected MCP servers. Many of their tools are not listed up front: describe what you need ' +
    '(e.g. "create a Jira issue", "query postgres"), and the matching tools are loaded and can be called from your next step.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the tool should do, or its name.' },
      limit: { type: 'integer', description: 'Maximum tools to load (default 5).', minimum: 1, maximum: 20 },
    },
    required: ['query'],
  },
  summarize: (i) => `Search tools: ${i.query}`,
  async execute(input, ctx) {
    const pool = deferredTools(ctx.runtime, Boolean(ctx.agent.session.meta?.lean));
    if (!pool.length) return { content: 'All tools are already available; no search needed.' };
    const index = new Bm25Index(pool.map((t) => ({ id: t.name, text: `${t.name.replace(/[_-]+/g, ' ')} ${t.description}`, data: t })));
    const exact = pool.filter((t) => t.name === input.query || t.name.endsWith(`__${input.query}`));
    const hits = [...exact, ...index.search(input.query, input.limit ?? 5).map((h) => h.data)].filter((t, i, a) => a.indexOf(t) === i).slice(0, input.limit ?? 5);
    if (!hits.length) {
      const servers = [...new Set(pool.map((t) => t.name.split('__')[1]))].join(', ');
      return { content: `No tool matched "${input.query}". Servers with deferred tools: ${servers}. Try other words.` };
    }
    const loaded = ctx.agent.loadTools(hits.map((t) => t.name));
    return {
      content:
        `Loaded ${hits.length} tool${hits.length === 1 ? '' : 's'}${loaded ? '' : ' (already loaded)'} — call them directly from your next step:\n\n` +
        hits.map((t) => `## ${t.name}\n${t.description}\nArguments:\n${describeArgs(t.parameters).join('\n') || '(none)'}`).join('\n\n'),
      meta: { loaded: hits.map((t) => t.name) },
    };
  },
};
