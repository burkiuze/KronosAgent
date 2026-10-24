import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, PermissionMode, Usage } from '../types.js';
import { emptyUsage, addUsage } from '../types.js';
import { Bm25Index, snippet as makeSnippet } from '../util/bm25.js';
import { newId } from '../util/misc.js';
import { logger } from '../util/log.js';

const log = logger('sessions');

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  profile: string;
  cwd: string;
  project: string;
  model: string;
  source: string;
  pinned: boolean;
  archived: boolean;
  parentId?: string;
  mode: PermissionMode;
  systemPrompt?: string;
  toolNames?: string[];
  meta: Record<string, unknown>;
  usage: Usage;
  messageCount: number;
}

export interface SessionListOptions {
  limit?: number;
  offset?: number;
  query?: string;
  source?: string;
  project?: string;
  includeArchived?: boolean;
  includeChildren?: boolean;
}

export interface SearchHit {
  sessionId: string;
  title: string;
  messageId: string;
  role: string;
  snippet: string;
  createdAt: number;
  score: number;
}

export interface UsageEntry {
  ts: number;
  sessionId: string;
  model: string;
  source: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  toolCalls?: number;
}

export interface UsageSummaryRow {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  requests: number;
  toolCalls: number;
}

export interface SessionStore {
  readonly kind: 'sqlite' | 'json';
  create(init: Partial<SessionRecord>): SessionRecord;
  get(id: string): SessionRecord | undefined;
  list(opts?: SessionListOptions): SessionRecord[];
  update(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined;
  delete(id: string): void;
  appendMessages(id: string, messages: Message[]): void;
  messages(id: string): Message[];
  truncate(id: string, keep: number): Message[];
  replaceMessages(id: string, messages: Message[]): void;
  search(query: string, opts?: { limit?: number; excludeSession?: string }): SearchHit[];
  logUsage(e: UsageEntry): void;
  usageSummary(opts: { since?: number; groupBy: 'day' | 'model' | 'session' | 'source' }): UsageSummaryRow[];
  close(): void;
}

export function messagePlainText(m: Message): string {
  const out: string[] = [];
  for (const p of m.parts) {
    if (p.type === 'text') out.push(p.text);
    else if (p.type === 'tool_call') out.push(`[${p.name}] ${JSON.stringify(p.input).slice(0, 400)}`);
    else if (p.type === 'tool_result') out.push(p.content.slice(0, 2000));
    else if (p.type === 'file') out.push(`[file ${p.name}]`);
  }
  return out.join('\n');
}

function defaults(init: Partial<SessionRecord>): SessionRecord {
  const now = Date.now();
  const cwd = init.cwd ?? process.cwd();
  return {
    id: init.id ?? newId('s_'),
    title: init.title ?? 'New conversation',
    createdAt: init.createdAt ?? now,
    updatedAt: init.updatedAt ?? now,
    profile: init.profile ?? 'default',
    cwd,
    project: init.project ?? (cwd.split(/[\\/]/).filter(Boolean).pop() || '~'),
    model: init.model ?? '',
    source: init.source ?? 'cli',
    pinned: init.pinned ?? false,
    archived: init.archived ?? false,
    parentId: init.parentId,
    mode: init.mode ?? 'ask',
    systemPrompt: init.systemPrompt,
    toolNames: init.toolNames,
    meta: init.meta ?? {},
    usage: init.usage ?? emptyUsage(),
    messageCount: init.messageCount ?? 0,
  };
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// SQLite (node:sqlite, FTS5)
// ---------------------------------------------------------------------------

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
  close(): void;
}

function loadSqlite(): { DatabaseSync: new (path: string) => SqliteDb } | null {
  if (process.env.KRONOS_DISABLE_SQLITE === '1') return null;
  const origEmit = process.emitWarning;
  try {
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const msg = typeof warning === 'string' ? warning : warning.message;
      if (/SQLite is an experimental feature/i.test(msg)) return;
      return (origEmit as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const mod = getBuiltin?.('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDb } | undefined;
    return mod ?? null;
  } catch {
    return null;
  } finally {
    setTimeout(() => {
      process.emitWarning = origEmit;
    }, 0).unref?.();
  }
}

class SqliteSessionStore implements SessionStore {
  readonly kind = 'sqlite' as const;
  private fts = true;
  constructor(private db: SqliteDb) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER, profile TEXT, cwd TEXT, project TEXT,
        model TEXT, source TEXT, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, parent_id TEXT, mode TEXT,
        system_prompt TEXT, tool_names TEXT, meta TEXT, usage TEXT, message_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT, data TEXT, created_at INTEGER, text TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
      CREATE TABLE IF NOT EXISTS usage_log (
        ts INTEGER, session_id TEXT, model TEXT, source TEXT, input INTEGER, output INTEGER, cache_read INTEGER,
        cache_write INTEGER, cost REAL, tool_calls INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
    `);
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, message_id UNINDEXED, session_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');`);
    } catch (e) {
      this.fts = false;
      log.warn('FTS5 unavailable, falling back to BM25 scan', e);
    }
  }

  private row(r: Record<string, unknown> | undefined): SessionRecord | undefined {
    if (!r) return undefined;
    return {
      id: String(r.id),
      title: String(r.title ?? ''),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      profile: String(r.profile ?? 'default'),
      cwd: String(r.cwd ?? ''),
      project: String(r.project ?? ''),
      model: String(r.model ?? ''),
      source: String(r.source ?? 'cli'),
      pinned: Boolean(r.pinned),
      archived: Boolean(r.archived),
      parentId: r.parent_id ? String(r.parent_id) : undefined,
      mode: (r.mode as PermissionMode) ?? 'ask',
      systemPrompt: r.system_prompt ? String(r.system_prompt) : undefined,
      toolNames: r.tool_names ? (JSON.parse(String(r.tool_names)) as string[]) : undefined,
      meta: r.meta ? (JSON.parse(String(r.meta)) as Record<string, unknown>) : {},
      usage: r.usage ? (JSON.parse(String(r.usage)) as Usage) : emptyUsage(),
      messageCount: Number(r.message_count ?? 0),
    };
  }

  create(init: Partial<SessionRecord>): SessionRecord {
    const s = defaults(init);
    this.db
      .prepare(
        `INSERT INTO sessions (id,title,created_at,updated_at,profile,cwd,project,model,source,pinned,archived,parent_id,mode,system_prompt,tool_names,meta,usage,message_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id, s.title, s.createdAt, s.updatedAt, s.profile, s.cwd, s.project, s.model, s.source, s.pinned ? 1 : 0, s.archived ? 1 : 0,
        s.parentId ?? null, s.mode, s.systemPrompt ?? null, s.toolNames ? JSON.stringify(s.toolNames) : null, JSON.stringify(s.meta),
        JSON.stringify(s.usage), s.messageCount,
      );
    return s;
  }

  get(id: string): SessionRecord | undefined {
    return this.row(this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined);
  }

  list(opts: SessionListOptions = {}): SessionRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (!opts.includeArchived) where.push('archived = 0');
    if (!opts.includeChildren) where.push('parent_id IS NULL');
    if (opts.source) {
      where.push('source LIKE ?');
      args.push(`${opts.source}%`);
    }
    if (opts.project) {
      where.push('project = ?');
      args.push(opts.project);
    }
    if (opts.query) {
      where.push('title LIKE ?');
      args.push(`%${opts.query}%`);
    }
    const sql = `SELECT id,title,created_at,updated_at,profile,cwd,project,model,source,pinned,archived,parent_id,mode,meta,usage,message_count FROM sessions ${
      where.length ? `WHERE ${where.join(' AND ')}` : ''
    } ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`;
    args.push(opts.limit ?? 200, opts.offset ?? 0);
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => this.row(r) as SessionRecord);
  }

  update(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next: SessionRecord = { ...cur, ...patch, meta: patch.meta ? { ...cur.meta, ...patch.meta } : cur.meta, updatedAt: patch.updatedAt ?? Date.now() };
    this.db
      .prepare(
        `UPDATE sessions SET title=?,updated_at=?,profile=?,cwd=?,project=?,model=?,source=?,pinned=?,archived=?,parent_id=?,mode=?,system_prompt=?,tool_names=?,meta=?,usage=?,message_count=? WHERE id=?`,
      )
      .run(
        next.title, next.updatedAt, next.profile, next.cwd, next.project, next.model, next.source, next.pinned ? 1 : 0, next.archived ? 1 : 0,
        next.parentId ?? null, next.mode, next.systemPrompt ?? null, next.toolNames ? JSON.stringify(next.toolNames) : null,
        JSON.stringify(next.meta), JSON.stringify(next.usage), next.messageCount, id,
      );
    return next;
  }

  delete(id: string): void {
    for (const child of this.db.prepare('SELECT id FROM sessions WHERE parent_id = ?').all(id) as { id: string }[]) this.delete(child.id);
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    if (this.fts) this.db.prepare('DELETE FROM messages_fts WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  appendMessages(id: string, messages: Message[]): void {
    if (!messages.length) return;
    const max = this.db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM messages WHERE session_id = ?').get(id) as { m: number };
    let seq = Number(max.m) + 1;
    const ins = this.db.prepare('INSERT OR REPLACE INTO messages (id, session_id, seq, role, data, created_at, text) VALUES (?,?,?,?,?,?,?)');
    const insFts = this.fts ? this.db.prepare('INSERT INTO messages_fts (text, message_id, session_id) VALUES (?,?,?)') : null;
    this.db.exec('BEGIN');
    try {
      for (const m of messages) {
        const text = messagePlainText(m);
        ins.run(m.id, id, seq++, m.role, JSON.stringify(m), m.createdAt, text);
        if (insFts && text.trim() && m.role !== 'system') insFts.run(text, m.id, id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(id) as { c: number };
    this.update(id, { messageCount: Number(count.c) });
  }

  messages(id: string): Message[] {
    return (this.db.prepare('SELECT data FROM messages WHERE session_id = ? ORDER BY seq').all(id) as { data: string }[]).map((r) => JSON.parse(r.data) as Message);
  }

  truncate(id: string, keep: number): Message[] {
    const all = this.messages(id);
    const removed = all.slice(keep);
    for (const m of removed) {
      this.db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
      if (this.fts) this.db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(m.id);
    }
    this.update(id, { messageCount: Math.min(keep, all.length) });
    return removed;
  }

  replaceMessages(id: string, messages: Message[]): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    if (this.fts) this.db.prepare('DELETE FROM messages_fts WHERE session_id = ?').run(id);
    this.appendMessages(id, messages);
  }

  search(query: string, opts: { limit?: number; excludeSession?: string } = {}): SearchHit[] {
    const limit = opts.limit ?? 10;
    let rows: { message_id: string; session_id: string; text: string; score: number }[] = [];
    if (this.fts) {
      const q = query
        .split(/\s+/)
        .map((t) => t.replace(/["*^():]/g, ''))
        .filter((t) => t.length > 1)
        .map((t) => `"${t}"*`)
        .join(' OR ');
      if (!q) return [];
      try {
        rows = this.db
          .prepare('SELECT message_id, session_id, text, bm25(messages_fts) AS score FROM messages_fts WHERE messages_fts MATCH ? ORDER BY score LIMIT ?')
          .all(q, limit * 4) as typeof rows;
      } catch (e) {
        log.debug('fts query failed', e);
      }
    } else {
      const all = this.db.prepare('SELECT id AS message_id, session_id, text FROM messages ORDER BY created_at DESC LIMIT 20000').all() as typeof rows;
      const idx = new Bm25Index(all.map((r) => ({ id: r.message_id, text: r.text ?? '', data: r })));
      rows = idx.search(query, limit * 4).map((h) => ({ ...h.data, score: -h.score }));
    }
    const hits: SearchHit[] = [];
    const seen = new Map<string, number>();
    for (const r of rows) {
      if (r.session_id === opts.excludeSession) continue;
      const n = seen.get(r.session_id) ?? 0;
      if (n >= 3) continue;
      seen.set(r.session_id, n + 1);
      const s = this.get(r.session_id);
      if (!s) continue;
      const m = this.db.prepare('SELECT role, created_at FROM messages WHERE id = ?').get(r.message_id) as { role: string; created_at: number } | undefined;
      hits.push({
        sessionId: r.session_id,
        title: s.title,
        messageId: r.message_id,
        role: m?.role ?? 'user',
        snippet: makeSnippet(r.text, query),
        createdAt: m?.created_at ?? s.updatedAt,
        score: -r.score,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  logUsage(e: UsageEntry): void {
    this.db
      .prepare('INSERT INTO usage_log (ts,session_id,model,source,input,output,cache_read,cache_write,cost,tool_calls) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(e.ts, e.sessionId, e.model, e.source, e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens, e.costUsd, e.toolCalls ?? 0);
  }

  usageSummary(opts: { since?: number; groupBy: 'day' | 'model' | 'session' | 'source' }): UsageSummaryRow[] {
    const rows = this.db.prepare('SELECT * FROM usage_log WHERE ts >= ? ORDER BY ts').all(opts.since ?? 0) as Record<string, number | string>[];
    return summarize(
      rows.map((r) => ({
        ts: Number(r.ts),
        sessionId: String(r.session_id),
        model: String(r.model),
        source: String(r.source),
        inputTokens: Number(r.input),
        outputTokens: Number(r.output),
        cacheReadTokens: Number(r.cache_read),
        cacheWriteTokens: Number(r.cache_write),
        costUsd: Number(r.cost),
        toolCalls: Number(r.tool_calls ?? 0),
      })),
      opts.groupBy,
    );
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

function summarize(entries: UsageEntry[], groupBy: 'day' | 'model' | 'session' | 'source'): UsageSummaryRow[] {
  const map = new Map<string, UsageSummaryRow>();
  for (const e of entries) {
    const key = groupBy === 'day' ? dayKey(e.ts) : groupBy === 'model' ? e.model : groupBy === 'session' ? e.sessionId : e.source;
    const row = map.get(key) ?? { key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0, toolCalls: 0 };
    row.inputTokens += e.inputTokens;
    row.outputTokens += e.outputTokens;
    row.cacheReadTokens += e.cacheReadTokens;
    row.cacheWriteTokens += e.cacheWriteTokens;
    row.costUsd += e.costUsd;
    row.requests += 1;
    row.toolCalls += e.toolCalls ?? 0;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => (groupBy === 'day' ? a.key.localeCompare(b.key) : b.costUsd - a.costUsd || b.outputTokens - a.outputTokens));
}

// ---------------------------------------------------------------------------
// JSON fallback (no native dependencies at all)
// ---------------------------------------------------------------------------

class JsonSessionStore implements SessionStore {
  readonly kind = 'json' as const;
  private index = new Map<string, SessionRecord>();
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.meta.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as SessionRecord;
        this.index.set(s.id, s);
      } catch {
        /* skip corrupt */
      }
    }
  }
  private metaFile(id: string) {
    return join(this.dir, `${id}.meta.json`);
  }
  private msgFile(id: string) {
    return join(this.dir, `${id}.jsonl`);
  }
  private saveMeta(s: SessionRecord) {
    const f = this.metaFile(s.id);
    writeFileSync(`${f}.tmp`, JSON.stringify(s));
    renameSync(`${f}.tmp`, f);
  }
  create(init: Partial<SessionRecord>): SessionRecord {
    const s = defaults(init);
    this.index.set(s.id, s);
    this.saveMeta(s);
    return s;
  }
  get(id: string) {
    return this.index.get(id);
  }
  list(opts: SessionListOptions = {}): SessionRecord[] {
    return [...this.index.values()]
      .filter((s) => (opts.includeArchived || !s.archived) && (opts.includeChildren || !s.parentId))
      .filter((s) => !opts.source || s.source.startsWith(opts.source))
      .filter((s) => !opts.project || s.project === opts.project)
      .filter((s) => !opts.query || s.title.toLowerCase().includes(opts.query.toLowerCase()))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 200))
      .map(({ systemPrompt: _s, toolNames: _t, ...rest }) => rest as SessionRecord);
  }
  update(id: string, patch: Partial<SessionRecord>) {
    const cur = this.index.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, meta: patch.meta ? { ...cur.meta, ...patch.meta } : cur.meta, updatedAt: patch.updatedAt ?? Date.now() };
    this.index.set(id, next);
    this.saveMeta(next);
    return next;
  }
  delete(id: string) {
    for (const s of this.index.values()) if (s.parentId === id) this.delete(s.id);
    this.index.delete(id);
    rmSync(this.metaFile(id), { force: true });
    rmSync(this.msgFile(id), { force: true });
  }
  appendMessages(id: string, messages: Message[]) {
    if (!messages.length) return;
    appendFileSync(this.msgFile(id), messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    const s = this.index.get(id);
    if (s) this.update(id, { messageCount: s.messageCount + messages.length });
  }
  messages(id: string): Message[] {
    const f = this.msgFile(id);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Message);
  }
  truncate(id: string, keep: number) {
    const all = this.messages(id);
    this.replaceMessages(id, all.slice(0, keep));
    return all.slice(keep);
  }
  replaceMessages(id: string, messages: Message[]) {
    writeFileSync(this.msgFile(id), messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : ''));
    this.update(id, { messageCount: messages.length });
  }
  search(query: string, opts: { limit?: number; excludeSession?: string } = {}): SearchHit[] {
    const docs: { id: string; text: string; data: { s: SessionRecord; m: Message; text: string } }[] = [];
    for (const s of this.index.values()) {
      if (s.id === opts.excludeSession) continue;
      for (const m of this.messages(s.id)) {
        if (m.role === 'system') continue;
        const text = messagePlainText(m);
        if (text.trim()) docs.push({ id: m.id, text, data: { s, m, text } });
      }
    }
    return new Bm25Index(docs).search(query, opts.limit ?? 10).map((h) => ({
      sessionId: h.data.s.id,
      title: h.data.s.title,
      messageId: h.data.m.id,
      role: h.data.m.role,
      snippet: makeSnippet(h.data.text, query),
      createdAt: h.data.m.createdAt,
      score: h.score,
    }));
  }
  logUsage(e: UsageEntry) {
    appendFileSync(join(this.dir, 'usage.jsonl'), `${JSON.stringify(e)}\n`);
  }
  usageSummary(opts: { since?: number; groupBy: 'day' | 'model' | 'session' | 'source' }) {
    const f = join(this.dir, 'usage.jsonl');
    if (!existsSync(f)) return [];
    const entries = readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as UsageEntry)
      .filter((e) => e.ts >= (opts.since ?? 0));
    return summarize(entries, opts.groupBy);
  }
  close() {}
}

export function openSessionStore(dbFile: string, jsonDir: string): SessionStore {
  const sqlite = loadSqlite();
  if (sqlite) {
    try {
      mkdirSync(join(dbFile, '..'), { recursive: true });
      return new SqliteSessionStore(new sqlite.DatabaseSync(dbFile));
    } catch (e) {
      log.warn('sqlite session store unavailable, using JSON files', e);
    }
  }
  return new JsonSessionStore(jsonDir);
}

export function totalUsage(sessions: SessionRecord[]): Usage {
  return sessions.reduce((acc, s) => addUsage(acc, s.usage), emptyUsage());
}
