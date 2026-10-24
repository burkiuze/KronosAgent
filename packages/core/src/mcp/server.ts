import { createInterface } from 'node:readline';
import type { Kronos } from '../runtime.js';
import type { PermissionMode } from '../types.js';
import { MCP_PROTOCOL_VERSION } from './client.js';
import { errorMessage, newId } from '../util/misc.js';
import { PermissionPolicy } from '../safety/permissions.js';
import { resolveRisk } from '../tools/types.js';
import type { ToolContext } from '../tools/types.js';

/**
 * Run Kronos as an MCP server over stdio. Exposes:
 *  - `kronos_agent`: run a full autonomous Kronos task and return the result
 *  - every enabled built-in tool (prefixed `kronos_`), gated by the configured permission mode
 * so Claude Code, Cursor, Codex and any MCP host can delegate to Kronos.
 */
export async function serveMcp(rt: Kronos, opts: { mode?: PermissionMode; exposeTools?: boolean } = {}): Promise<void> {
  const mode = opts.mode ?? (rt.config.safety.mode === 'ask' ? 'plan' : rt.config.safety.mode);
  const policy = new PermissionPolicy(rt.config.safety);
  const session = rt.createSession({ source: 'mcp', title: 'MCP client' });
  const agent = rt.createAgent({ session, surface: 'api', autoApprove: mode === 'yolo' });
  const tools = opts.exposeTools === false ? [] : rt.tools.resolve(rt.config.toolsets.enabled, rt, { exclude: ['ask_user', 'exit_plan_mode', 'delegate'] });

  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const listTools = () => [
    {
      name: 'kronos_agent',
      description:
        'Run an autonomous Kronos Agent task (multi-step: tools, web, files, shell, memory, skills, subagents) and return its final report. Give a complete, self-contained instruction.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What Kronos should do.' },
          model: { type: 'string', description: 'Optional model ref, e.g. anthropic:claude-opus-5-5.' },
          cwd: { type: 'string', description: 'Working directory.' },
        },
        required: ['task'],
      },
    },
    ...tools.map((t) => ({ name: `kronos_${t.name}`, description: t.description, inputSchema: { type: 'object', ...t.parameters } })),
  ];

  const call = async (name: string, args: Record<string, unknown>) => {
    if (name === 'kronos_agent') {
      const r = await rt.runHeadless(String(args.task ?? ''), { source: 'mcp', model: args.model as string | undefined, cwd: args.cwd as string | undefined, mode, autoApprove: mode === 'yolo' });
      return { content: [{ type: 'text', text: r.text || r.error || '(no output)' }], isError: r.stopReason === 'error' };
    }
    const def = tools.find((t) => `kronos_${t.name}` === name);
    if (!def) return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
    const check = policy.check({ name: def.name, toolset: def.toolset, risk: resolveRisk(def, args), input: args, cwd: session.cwd }, mode);
    if (check.action !== 'allow') return { content: [{ type: 'text', text: `Not permitted in "${mode}" mode: ${check.reason}. Start \`kronos mcp serve --mode yolo\` to allow it.` }], isError: true };
    const ctl = new AbortController();
    const ctx: ToolContext = {
      runtime: rt,
      agent,
      sessionId: session.id,
      cwd: session.cwd,
      signal: ctl.signal,
      toolCallId: newId('mcp_'),
      turn: 0,
      progress: () => undefined,
      askUser: async () => '',
      checkpoint: (p) => rt.checkpoints.snapshot(session.id, 0, p, 'mcp'),
    };
    const out = await def.execute(args, ctx);
    const content: unknown[] = [{ type: 'text', text: out.content }];
    for (const img of out.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mediaType });
    return { content, isError: Boolean(out.isError) };
  };

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue; // notifications
    try {
      let result: unknown;
      switch (msg.method) {
        case 'initialize':
          result = {
            protocolVersion: (msg.params?.protocolVersion as string) ?? MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'kronos-agent', version: '1.0.0' },
            instructions: 'Kronos Agent: call kronos_agent to delegate a complete task, or use the individual kronos_* tools.',
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: listTools() };
          break;
        case 'tools/call':
          result = await call(String(msg.params?.name), (msg.params?.arguments ?? {}) as Record<string, unknown>);
          break;
        case 'resources/list':
          result = { resources: [] };
          break;
        case 'prompts/list':
          result = { prompts: [] };
          break;
        default:
          write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
          continue;
      }
      write({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: errorMessage(e) }], isError: true } });
    }
  }
}
