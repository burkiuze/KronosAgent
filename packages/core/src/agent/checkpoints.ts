import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface FileSnapshot {
  path: string;
  existed: boolean;
  /** base64 content when the file existed */
  content?: string;
}

interface CheckpointFile {
  sessionId: string;
  turn: number;
  createdAt: number;
  label: string;
  files: FileSnapshot[];
}

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/**
 * File checkpoints: before any tool modifies a file we snapshot the original once per
 * user turn, so `/undo` and `/rewind` can restore the workspace (like Cline / Gemini CLI
 * checkpoints, without needing git).
 */
export class CheckpointManager {
  constructor(private readonly root: string) {}

  private dir(sessionId: string): string {
    return join(this.root, sessionId);
  }

  private file(sessionId: string, turn: number): string {
    return join(this.dir(sessionId), `${String(turn).padStart(5, '0')}.json`);
  }

  private load(sessionId: string, turn: number): CheckpointFile | undefined {
    const f = this.file(sessionId, turn);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as CheckpointFile;
    } catch {
      return undefined;
    }
  }

  /** Record the pre-change state of `path` for this turn (first write wins). */
  snapshot(sessionId: string, turn: number, path: string, label = ''): void {
    const cp = this.load(sessionId, turn) ?? { sessionId, turn, createdAt: Date.now(), label, files: [] };
    if (cp.files.some((f) => f.path === path)) return;
    let snap: FileSnapshot = { path, existed: false };
    if (existsSync(path)) {
      const st = statSync(path);
      if (!st.isFile()) return;
      if (st.size > MAX_SNAPSHOT_BYTES) return;
      snap = { path, existed: true, content: readFileSync(path).toString('base64') };
    }
    cp.files.push(snap);
    if (label && !cp.label) cp.label = label;
    mkdirSync(this.dir(sessionId), { recursive: true });
    writeFileSync(this.file(sessionId, turn), JSON.stringify(cp));
  }

  list(sessionId: string): { turn: number; files: string[]; createdAt: number; label: string }[] {
    const d = this.dir(sessionId);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.load(sessionId, parseInt(f, 10)))
      .filter((c): c is CheckpointFile => Boolean(c))
      .map((c) => ({ turn: c.turn, files: c.files.map((f) => f.path), createdAt: c.createdAt, label: c.label }))
      .sort((a, b) => a.turn - b.turn);
  }

  /** Restore every checkpoint with turn >= fromTurn (newest first). Returns restored paths. */
  restore(sessionId: string, fromTurn: number): string[] {
    const restored: string[] = [];
    const cps = this.list(sessionId)
      .filter((c) => c.turn >= fromTurn)
      .sort((a, b) => b.turn - a.turn);
    for (const meta of cps) {
      const cp = this.load(sessionId, meta.turn);
      if (!cp) continue;
      for (const f of cp.files) {
        try {
          if (f.existed && f.content !== undefined) {
            mkdirSync(dirname(f.path), { recursive: true });
            writeFileSync(f.path, Buffer.from(f.content, 'base64'));
          } else if (!f.existed && existsSync(f.path)) {
            unlinkSync(f.path);
          }
          if (!restored.includes(f.path)) restored.push(f.path);
        } catch {
          /* keep going */
        }
      }
      rmSync(this.file(sessionId, meta.turn), { force: true });
    }
    return restored;
  }

  clear(sessionId: string): void {
    rmSync(this.dir(sessionId), { recursive: true, force: true });
  }
}
