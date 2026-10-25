import { createHash } from 'node:crypto';

/** What the loop should do after a batch of tool results. */
export type WatchVerdict = { kind: 'ok' } | { kind: 'warn'; note: string } | { kind: 'stop'; reason: string };

/** Tools that are normally called again with the same input (polling, re-running checks, plans). */
const REPEATABLE = new Set(['shell', 'process', 'verify', 'execute_code', 'todo_write', 'team_board', 'delegate', 'browser', 'http_request', 'send_message']);

const WARN_FAILURES = 3;
const STOP_FAILURES = 6;
const WARN_REPEATS = 4;

function signature(name: string, input: unknown): string {
  const stable = JSON.stringify(input, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
  return `${name}:${createHash('sha1').update(stable ?? '').digest('hex').slice(0, 16)}`;
}

/**
 * Notices when a run stops making progress: the same call failing again and again, or the same
 * read repeated although its result is already in context. Long-running agent systems need a
 * watchdog in the harness — a model stuck in a loop rarely notices by itself — so the loop first
 * tells the model plainly, and ends the run if it keeps going.
 */
export class LoopWatch {
  private failures = new Map<string, { count: number; tool: string; error: string }>();
  private successes = new Map<string, number>();
  private warned = new Set<string>();

  observe(calls: { name: string; input: unknown; isError: boolean; content: string }[]): WatchVerdict {
    const notes: string[] = [];
    for (const c of calls) {
      const sig = signature(c.name, c.input);
      if (c.isError) {
        const f = this.failures.get(sig) ?? { count: 0, tool: c.name, error: '' };
        f.count += 1;
        f.error = c.content.split('\n').find((l) => l.trim())?.slice(0, 240) ?? '';
        this.failures.set(sig, f);
        if (f.count >= STOP_FAILURES) {
          return { kind: 'stop', reason: `Stopped: ${c.name} failed ${f.count} times with the same input (${f.error || 'no message'}). The run was not making progress.` };
        }
        if (f.count >= WARN_FAILURES && !this.warned.has(`f:${sig}`)) {
          this.warned.add(`f:${sig}`);
          notes.push(
            `${c.name} has now failed ${f.count} times with exactly the same input ("${f.error}"). Repeating it will not help: read the error, check your assumptions (paths, names, permissions, state), and change the approach — or explain the blocker to the user.`,
          );
        }
        continue;
      }
      this.failures.delete(sig);
      if (REPEATABLE.has(c.name)) continue;
      const n = (this.successes.get(sig) ?? 0) + 1;
      this.successes.set(sig, n);
      if (n >= WARN_REPEATS && !this.warned.has(`s:${sig}`)) {
        this.warned.add(`s:${sig}`);
        notes.push(`You have called ${c.name} with the same input ${n} times in this run; its result is already above. Use it, or do something different to make progress.`);
      }
    }
    return notes.length ? { kind: 'warn', note: notes.join('\n') } : { kind: 'ok' };
  }
}
