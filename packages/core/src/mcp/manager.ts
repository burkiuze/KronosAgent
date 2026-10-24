import type { McpServerConfig } from '../config/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition } from '../tools/types.js';
import { McpClient } from './client.js';
import { withTimeout, errorMessage } from '../util/misc.js';
import { matchGlob } from '../util/glob.js';
import { logger } from '../util/log.js';

const log = logger('mcp');

export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  status: 'connecting' | 'connected' | 'error' | 'disabled';
  error?: string;
  tools: string[];
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private states = new Map<string, McpServerStatus>();

  constructor(private registry: ToolRegistry) {}

  status(): McpServerStatus[] {
    return [...this.states.values()];
  }

  /** Server instructions to add to the system prompt. */
  instructions(): string {
    return [...this.states.values()]
      .filter((s) => s.status === 'connected' && s.instructions)
      .map((s) => `### ${s.name}\n${s.instructions}`)
      .join('\n\n');
  }

  async connectAll(servers: Record<string, McpServerConfig>, timeoutMs = 20_000): Promise<void> {
    await this.closeAll();
    await Promise.all(
      Object.entries(servers).map(async ([name, cfg]) => {
        if (cfg.enabled === false) {
          this.states.set(name, { name, transport: cfg.url ? 'http' : 'stdio', status: 'disabled', tools: [] });
          return;
        }
        await this.connect(name, cfg, timeoutMs);
      }),
    );
  }

  async connect(name: string, cfg: McpServerConfig, timeoutMs = 20_000): Promise<McpServerStatus> {
    const state: McpServerStatus = { name, transport: cfg.url ? 'http' : 'stdio', status: 'connecting', tools: [] };
    this.states.set(name, state);
    const client = new McpClient(name, cfg);
    try {
      await withTimeout(client.connect(), timeoutMs, `MCP ${name} initialize`);
      const tools = await withTimeout(client.listTools(), timeoutMs, `MCP ${name} tools/list`);
      this.clients.set(name, client);
      state.serverInfo = client.serverInfo;
      state.instructions = client.instructions;
      for (const t of tools) {
        if (cfg.include?.length && !cfg.include.some((p) => matchGlob(t.name, p))) continue;
        if (cfg.exclude?.some((p) => matchGlob(t.name, p))) continue;
        const fullName = mcpToolName(name, t.name);
        const def: ToolDefinition = {
          name: fullName,
          toolset: 'mcp',
          risk: t.annotations?.readOnlyHint ? 'read' : 'external',
          parallelSafe: Boolean(t.annotations?.readOnlyHint),
          description: `[MCP ${name}] ${t.description ?? t.annotations?.title ?? t.name}`.slice(0, 4000),
          parameters: { type: 'object', properties: {}, ...(t.inputSchema ?? {}) },
          summarize: () => `${name} · ${t.annotations?.title ?? t.name}`,
          execute: async (input, ctx) => {
            const live = this.clients.get(name);
            if (!live) return { content: `MCP server "${name}" is not connected`, isError: true };
            const r = await live.callTool(t.name, input, cfg.timeoutMs);
            void ctx;
            return { content: r.text || (r.images.length ? '(image result)' : '(empty result)'), images: r.images, isError: r.isError };
          },
        };
        this.registry.register(def);
        state.tools.push(fullName);
      }
      state.status = 'connected';
      log.info(`connected MCP server ${name} (${state.tools.length} tools)`);
    } catch (e) {
      state.status = 'error';
      state.error = `${errorMessage(e)}${client.stderrTail ? `\n${client.stderrTail.trim().slice(-400)}` : ''}`;
      log.warn(`MCP server ${name} failed: ${state.error}`);
      await client.close();
    }
    return state;
  }

  async disconnect(name: string): Promise<void> {
    await this.clients.get(name)?.close();
    this.clients.delete(name);
    this.registry.unregisterWhere((d) => d.name.startsWith(`mcp__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}__`));
    this.states.delete(name);
  }

  async closeAll(): Promise<void> {
    for (const name of [...this.clients.keys()]) await this.disconnect(name);
    this.registry.unregisterWhere((d) => d.toolset === 'mcp');
    this.states.clear();
  }
}
