import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Bm25Index } from '../util/bm25.js';

export type MemoryTarget = 'memory' | 'user';

export interface MemoryLimits {
  memory: number;
  user: number;
}

export interface MemoryResult {
  ok: boolean;
  message: string;
  entries?: string[];
}

export interface MemoryChange {
  ts: number;
  target: MemoryTarget;
  action: 'add' | 'patch' | 'remove' | 'replace_all';
  content?: string;
  old?: string;
  sessionId?: string;
}

const SEP = '\n§\n';

/**
 * Bounded, agent-curated memory: MEMORY.md (the agent's own notes) and USER.md
 * (a profile of the user). Entries are loaded into the system prompt as a frozen
 * snapshot at session start (cache friendly); writes persist immediately.
 */
export class MemoryStore {
  constructor(
    private readonly dir: string,
    private limits: MemoryLimits,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  setLimits(limits: MemoryLimits): void {
    this.limits = limits;
  }

  file(target: MemoryTarget): string {
    return join(this.dir, target === 'user' ? 'USER.md' : 'MEMORY.md');
  }

  entries(target: MemoryTarget): string[] {
    const f = this.file(target);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .split(/\n§\n|\r\n§\r\n/)
      .map((e) => e.trim())
      .filter(Boolean);
  }

  limit(target: MemoryTarget): number {
    return target === 'user' ? this.limits.user : this.limits.memory;
  }

  usage(target: MemoryTarget): { chars: number; limit: number; entries: number } {
    const e = this.entries(target);
    return { chars: e.join(SEP).length, limit: this.limit(target), entries: e.length };
  }

  private write(target: MemoryTarget, entries: string[]): void {
    const f = this.file(target);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, entries.length ? `${entries.join(SEP)}\n` : '');
    renameSync(tmp, f);
  }

  private log(change: MemoryChange): void {
    try {
      appendFileSync(join(this.dir, 'changes.jsonl'), `${JSON.stringify(change)}\n`);
    } catch {
      /* best effort */
    }
  }

  changes(limit = 50): MemoryChange[] {
    const f = join(this.dir, 'changes.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as MemoryChange;
        } catch {
          return null;
        }
      })
      .filter((x): x is MemoryChange => x !== null)
      .reverse();
  }

  private fits(target: MemoryTarget, entries: string[]): boolean {
    return entries.join(SEP).length <= this.limit(target);
  }

  private overflowMessage(target: MemoryTarget, entries: string[]): string {
    const used = entries.join(SEP).length;
    return (
      `${target === 'user' ? 'USER profile' : 'MEMORY'} would be ${used}/${this.limit(target)} chars — over the limit. ` +
      'Make room first: consolidate related entries with `patch`, or `remove` stale ones, then retry. Current entries:\n' +
      this.entries(target).map((e, i) => `${i + 1}. ${e}`).join('\n')
    );
  }

  private findOne(entries: string[], oldText: string): { index: number; error?: string } {
    const exact = entries.findIndex((e) => e === oldText.trim());
    if (exact >= 0) return { index: exact };
    const matches = entries.map((e, i) => (e.includes(oldText) ? i : -1)).filter((i) => i >= 0);
    if (matches.length === 0) return { index: -1, error: `No entry contains "${oldText}".` };
    if (matches.length > 1) return { index: -1, error: `"${oldText}" matches ${matches.length} entries; use a longer, unique substring.` };
    return { index: matches[0] as number };
  }

  add(target: MemoryTarget, content: string, sessionId?: string): MemoryResult {
    const text = content.trim();
    if (!text) return { ok: false, message: 'content is empty' };
    const entries = this.entries(target);
    if (entries.some((e) => e === text)) return { ok: true, message: 'Already remembered.', entries };
    const next = [...entries, text];
    if (!this.fits(target, next)) return { ok: false, message: this.overflowMessage(target, next) };
    this.write(target, next);
    this.log({ ts: Date.now(), target, action: 'add', content: text, sessionId });
    return { ok: true, message: `Saved to ${target === 'user' ? 'USER profile' : 'MEMORY'} (${this.usageLine(target)}).`, entries: next };
  }

  patch(target: MemoryTarget, oldText: string, content: string, sessionId?: string): MemoryResult {
    const entries = this.entries(target);
    const { index, error } = this.findOne(entries, oldText);
    if (error) return { ok: false, message: error };
    const entry = entries[index] as string;
    let updated: string;
    if (entry === oldText.trim()) updated = content.trim();
    else {
      const count = entry.split(oldText).length - 1;
      if (count > 1) return { ok: false, message: `"${oldText}" occurs ${count} times inside the entry; include more surrounding text.` };
      updated = entry.replace(oldText, content);
    }
    const next = [...entries];
    if (updated.trim()) next[index] = updated.trim();
    else next.splice(index, 1);
    if (!this.fits(target, next)) return { ok: false, message: this.overflowMessage(target, next) };
    this.write(target, next);
    this.log({ ts: Date.now(), target, action: 'patch', content: updated, old: entry, sessionId });
    return { ok: true, message: `Updated (${this.usageLine(target)}).`, entries: next };
  }

  remove(target: MemoryTarget, oldText: string, sessionId?: string): MemoryResult {
    const entries = this.entries(target);
    const { index, error } = this.findOne(entries, oldText);
    if (error) return { ok: false, message: error };
    const [removed] = entries.splice(index, 1);
    this.write(target, entries);
    this.log({ ts: Date.now(), target, action: 'remove', old: removed, sessionId });
    return { ok: true, message: `Removed (${this.usageLine(target)}).`, entries };
  }

  replaceAll(target: MemoryTarget, entries: string[]): MemoryResult {
    const clean = entries.map((e) => e.trim()).filter(Boolean);
    if (!this.fits(target, clean)) return { ok: false, message: this.overflowMessage(target, clean) };
    this.write(target, clean);
    this.log({ ts: Date.now(), target, action: 'replace_all' });
    return { ok: true, message: 'Saved.', entries: clean };
  }

  search(query: string, limit = 8): { target: MemoryTarget; entry: string; score: number }[] {
    const docs = (['memory', 'user'] as MemoryTarget[]).flatMap((target) =>
      this.entries(target).map((entry, i) => ({ id: `${target}:${i}`, text: entry, data: { target, entry } })),
    );
    const idx = new Bm25Index(docs);
    return idx.search(query, limit).map((h) => ({ ...h.data, score: h.score }));
  }

  usageLine(target: MemoryTarget): string {
    const u = this.usage(target);
    return `${Math.round((u.chars / u.limit) * 100)}% — ${u.chars.toLocaleString()}/${u.limit.toLocaleString()} chars`;
  }

  /** Render one store as the frozen block injected into the system prompt. */
  render(target: MemoryTarget): string {
    const entries = this.entries(target);
    const title = target === 'user' ? 'USER PROFILE (what you know about the user)' : 'MEMORY (your personal notes)';
    const bar = '═'.repeat(46);
    const body = entries.length ? entries.join(SEP) : '(empty)';
    return `${bar}\n${title} [${this.usageLine(target)}]\n${bar}\n${body}`;
  }

  snapshot(): string {
    return `${this.render('memory')}\n\n${this.render('user')}`;
  }
}
