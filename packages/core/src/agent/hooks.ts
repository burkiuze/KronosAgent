import type { HookConfig, KronosConfig } from '../config/schema.js';
import { runShell } from '../util/process.js';
import { matchGlob } from '../util/glob.js';
import { logger } from '../util/log.js';

const log = logger('hooks');

export type HookEvent = 'preToolUse' | 'postToolUse' | 'userPromptSubmit' | 'sessionStart' | 'stop';

export interface HookOutcome {
  /** a pre hook (exit code 2 or {"decision":"block"}) refused the action */
  blocked: boolean;
  reason?: string;
  /** extra context to hand to the model */
  context?: string;
}

/**
 * Lifecycle hooks (Claude Code compatible semantics): shell commands that receive a JSON
 * payload on stdin. Exit code 2, or stdout {"decision":"block","reason":…}, blocks the action;
 * other stdout is passed back to the model as additional context.
 */
export class HookRunner {
  constructor(private hooks: KronosConfig['hooks']) {}

  update(hooks: KronosConfig['hooks']): void {
    this.hooks = hooks;
  }

  has(event: HookEvent): boolean {
    return (this.hooks[event] ?? []).length > 0;
  }

  async run(event: HookEvent, payload: Record<string, unknown>, opts: { toolName?: string; cwd: string }): Promise<HookOutcome> {
    const list: HookConfig[] = (this.hooks[event] ?? []).filter((h) => !h.matcher || !opts.toolName || matchGlob(opts.toolName, h.matcher));
    const contexts: string[] = [];
    for (const h of list) {
      const res = await runShell(h.command, {
        cwd: opts.cwd,
        input: JSON.stringify({ event, ...payload }),
        timeoutMs: h.timeoutMs ?? 30_000,
        env: { KRONOS_HOOK_EVENT: event, KRONOS_TOOL_NAME: opts.toolName ?? '' },
      });
      const out = res.stdout.trim();
      if (res.exitCode === 2) return { blocked: true, reason: res.stderr.trim() || out || `blocked by ${event} hook` };
      if (res.exitCode !== 0) {
        log.warn(`${event} hook "${h.command}" exited ${res.exitCode}: ${res.stderr.trim()}`);
        continue;
      }
      if (out.startsWith('{')) {
        try {
          const j = JSON.parse(out) as { decision?: string; reason?: string; context?: string; additionalContext?: string };
          if (j.decision === 'block' || j.decision === 'deny') return { blocked: true, reason: j.reason ?? `blocked by ${event} hook` };
          const ctx = j.context ?? j.additionalContext;
          if (ctx) contexts.push(ctx);
          continue;
        } catch {
          /* plain text */
        }
      }
      if (out) contexts.push(out);
    }
    return { blocked: false, context: contexts.length ? contexts.join('\n') : undefined };
  }
}
