import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef } from '../types.js';
import { newId } from '../util/misc.js';

export interface Artifact extends ArtifactRef {
  id: string;
  sessionId?: string;
  sessionTitle?: string;
  createdAt: number;
  meta?: Record<string, unknown>;
}

/** Every file, image and link the agent produced or touched, in one place. */
export class ArtifactStore {
  private file: string;
  private items: Artifact[] = [];
  private listeners = new Set<(a: Artifact) => void>();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'artifacts.jsonl');
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.items.push(JSON.parse(line) as Artifact);
        } catch {
          /* skip */
        }
      }
    }
  }

  onAdd(fn: (a: Artifact) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  add(a: Omit<Artifact, 'id' | 'createdAt'> & { createdAt?: number }): Artifact {
    const existing = this.items.find((x) => x.location === a.location && x.sessionId === a.sessionId && x.kind === a.kind);
    if (existing) {
      existing.createdAt = Date.now();
      existing.title = a.title || existing.title;
      this.rewrite();
      return existing;
    }
    const item: Artifact = { ...a, id: newId('a_'), createdAt: a.createdAt ?? Date.now() };
    this.items.push(item);
    appendFileSync(this.file, `${JSON.stringify(item)}\n`);
    for (const fn of this.listeners) fn(item);
    return item;
  }

  list(opts: { kind?: ArtifactRef['kind']; query?: string; sessionId?: string; limit?: number } = {}): Artifact[] {
    const q = opts.query?.toLowerCase();
    return this.items
      .filter((a) => !opts.kind || a.kind === opts.kind)
      .filter((a) => !opts.sessionId || a.sessionId === opts.sessionId)
      .filter((a) => !q || `${a.title} ${a.location} ${a.sessionTitle ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, opts.limit ?? 500);
  }

  remove(id: string): boolean {
    const n = this.items.length;
    this.items = this.items.filter((a) => a.id !== id);
    if (this.items.length !== n) this.rewrite();
    return this.items.length !== n;
  }

  renameSession(sessionId: string, title: string): void {
    let changed = false;
    for (const a of this.items) {
      if (a.sessionId === sessionId && a.sessionTitle !== title) {
        a.sessionTitle = title;
        changed = true;
      }
    }
    if (changed) this.rewrite();
  }

  counts(): Record<string, number> {
    const c: Record<string, number> = { all: this.items.length, file: 0, image: 0, link: 0 };
    for (const a of this.items) c[a.kind] = (c[a.kind] ?? 0) + 1;
    return c;
  }

  private rewrite(): void {
    writeFileSync(this.file, this.items.map((a) => JSON.stringify(a)).join('\n') + (this.items.length ? '\n' : ''));
  }
}
