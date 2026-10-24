import type { ToolSpec } from '../types.js';
import type { Kronos } from '../runtime.js';
import { TOOLSETS, type ToolDefinition, type ToolsetInfo } from './types.js';

export interface ToolsetStatus extends ToolsetInfo {
  enabled: boolean;
  available: boolean;
  reason?: string;
  tools: { name: string; description: string; available: boolean; reason?: string }[];
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    this.tools.set(def.name, def as ToolDefinition);
  }

  registerAll(defs: ToolDefinition[]): void {
    for (const d of defs) this.register(d);
  }

  unregisterWhere(pred: (d: ToolDefinition) => boolean): void {
    for (const [k, v] of this.tools) if (pred(v)) this.tools.delete(k);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Tools the model may call, given enabled toolsets and availability. */
  resolve(enabledToolsets: string[], rt: Kronos, opts: { exclude?: string[]; only?: string[] } = {}): ToolDefinition[] {
    const enabled = new Set(enabledToolsets);
    return this.all()
      .filter((t) => enabled.has(t.toolset) || t.toolset === 'core')
      .filter((t) => !opts.exclude?.includes(t.name))
      .filter((t) => !opts.only || opts.only.includes(t.name) || opts.only.includes(t.toolset))
      .filter((t) => !t.available || t.available(rt) === null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  specs(defs: ToolDefinition[]): ToolSpec[] {
    return defs.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));
  }

  status(rt: Kronos, enabledToolsets: string[]): ToolsetStatus[] {
    const sets: ToolsetInfo[] = [...TOOLSETS];
    const known = new Set(sets.map((s) => s.id));
    for (const t of this.all()) {
      if (!known.has(t.toolset) && t.toolset !== 'core') {
        known.add(t.toolset);
        sets.push({ id: t.toolset, label: t.toolset, description: 'Plugin toolset' });
      }
    }
    return sets.map((s) => {
      const tools = this.all()
        .filter((t) => t.toolset === s.id)
        .map((t) => {
          const reason = t.available?.(rt) ?? null;
          return { name: t.name, description: t.description.split('\n')[0] ?? '', available: reason === null, reason: reason ?? undefined };
        });
      const unavailable = tools.length > 0 && tools.every((t) => !t.available);
      return {
        ...s,
        enabled: enabledToolsets.includes(s.id),
        available: !unavailable,
        reason: unavailable ? tools[0]?.reason : undefined,
        tools,
      };
    });
  }
}
