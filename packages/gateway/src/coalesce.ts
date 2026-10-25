import type { AgentEvent } from '@kronos/core';

type DeltaEvent = Extract<AgentEvent, { type: 'text_delta' | 'thinking_delta' | 'tool_call_delta' }>;

const isDelta = (e: AgentEvent): e is DeltaEvent => e.type === 'text_delta' || e.type === 'thinking_delta' || e.type === 'tool_call_delta';

function mergeable(a: DeltaEvent, b: DeltaEvent): boolean {
  if (a.type !== b.type || a.runId !== b.runId) return false;
  return a.type !== 'tool_call_delta' || a.id === (b as typeof a).id;
}

/**
 * Coalesces streaming deltas per session before they go out to UI clients.
 *
 * A fast model produces hundreds of token deltas a second; sending each one as its own
 * WebSocket frame made JSON encoding, framing and socket writes the gateway's main cost while
 * streaming. Consecutive deltas of the same kind are merged and sent at most every
 * `intervalMs`. Any other event flushes that session's pending deltas first, so clients see
 * exactly the same sequence, just in fewer, larger pieces.
 */
export class DeltaCoalescer {
  private pending = new Map<string, DeltaEvent[]>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deliver: (sessionId: string, event: AgentEvent) => void,
    private readonly intervalMs = 32,
  ) {}

  push(sessionId: string, event: AgentEvent): void {
    if (!isDelta(event)) {
      this.flush(sessionId);
      this.deliver(sessionId, event);
      return;
    }
    const list = this.pending.get(sessionId);
    const last = list?.[list.length - 1];
    if (last && mergeable(last, event)) {
      if (last.type === 'tool_call_delta') last.partialJson += (event as typeof last).partialJson;
      else last.text += (event as typeof last).text;
    } else {
      // a copy: other listeners of the runtime may still hold the original event
      const copy = { ...event };
      if (list) list.push(copy);
      else this.pending.set(sessionId, [copy]);
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flushAll(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  flush(sessionId: string): void {
    const list = this.pending.get(sessionId);
    if (!list) return;
    this.pending.delete(sessionId);
    for (const e of list) this.deliver(sessionId, e);
  }

  flushAll(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const id of [...this.pending.keys()]) this.flush(id);
  }
}
