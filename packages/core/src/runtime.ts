import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import type { AgentEvent, FilePart, ImagePart, PermissionMode, UserInput } from './types.js';
import { emptyUsage } from './types.js';
import { NotConnectedError } from './providers/errors.js';
import type { KronosConfig } from './config/schema.js';
import { loadConfig, saveConfigPatch, setConfigValue, type LoadedConfig } from './config/load.js';
import { activeProfile, bundledSkillsDir, ensureDirs, kronosHome, profileDir, profilePaths, resolvePath, type ProfilePaths } from './config/paths.js';
import { ProviderRegistry } from './providers/registry.js';
import { ToolRegistry } from './tools/registry.js';
import { fileTools } from './tools/files.js';
import { shellTools } from './tools/shell.js';
import { webTools } from './tools/web.js';
import { browserTools, BrowserManager } from './tools/browser.js';
import { agenticTools } from './tools/agentic.js';
import { MemoryStore } from './memory/store.js';
import { SkillRegistry } from './skills/registry.js';
import { openSessionStore, type SessionRecord, type SessionStore } from './sessions/store.js';
import { ArtifactStore } from './artifacts/store.js';
import { CheckpointManager } from './agent/checkpoints.js';
import { HookRunner } from './agent/hooks.js';
import { CronScheduler, type CronJob } from './cron/scheduler.js';
import { McpManager } from './mcp/manager.js';
import { createBackend, ProcessManager, type ExecBackend } from './backends/terminal.js';
import { Agent, type AgentOptions } from './agent/agent.js';
import { loadAgentDefinitions, type AgentDefinition } from './agent/definitions.js';
import { sendPlatformMessage, type PlatformId } from './messaging/senders.js';
import { parseFrontmatter } from './util/frontmatter.js';
import { configureLogger, logger } from './util/log.js';
import { Emitter, newId } from './util/misc.js';
import { looksBinary, truncate } from './util/text.js';

const log = logger('runtime');

export interface KronosOptions {
  home?: string;
  profile?: string;
  cwd?: string;
  overrides?: Partial<Record<keyof KronosConfig, unknown>>;
  /** connect MCP servers during create() (default true) */
  connectMcp?: boolean;
  /** start the cron scheduler (gateway/desktop do; one-shot CLI runs don't) */
  startCron?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export type RuntimeEvent =
  | { type: 'agent'; sessionId: string; event: AgentEvent }
  | { type: 'session_updated'; sessionId: string }
  | { type: 'config_changed' }
  | { type: 'cron'; kind: 'updated' | 'run_start' | 'run_end'; job: CronJob }
  | { type: 'artifact_added'; artifactId: string };

export interface ExpandedInput extends UserInput {
  /** a skill or custom command was invoked */
  command?: string;
}

export interface CommandInfo {
  name: string;
  description: string;
  source: 'skill' | 'command';
}

/** Outbound bridge installed by the gateway so tools can reach running platform adapters. */
export type MessagingBridge = (platform: PlatformId, target: string, text: string) => Promise<void>;

/**
 * The Kronos runtime: one per profile. Owns configuration, providers, tools, memory,
 * skills, sessions, artifacts, cron, MCP connections and live agents. Every surface
 * (CLI, gateway/desktop, messaging adapters, MCP server) is a thin layer over it.
 */
export interface SkillStats {
  uses: number;
  lastUsed: number;
  ok?: number;
  failed?: number;
}

export class Kronos {
  readonly events = new Emitter<RuntimeEvent>();
  readonly home: string;
  readonly profile: string;
  readonly paths: ProfilePaths;
  readonly tools = new ToolRegistry();
  readonly processes = new ProcessManager();
  readonly browser = new BrowserManager();
  cwd: string;
  config!: KronosConfig;
  rawConfig!: KronosConfig;
  configFiles!: LoadedConfig['files'];
  providers!: ProviderRegistry;
  memory!: MemoryStore;
  skills!: SkillRegistry;
  sessions!: SessionStore;
  artifacts!: ArtifactStore;
  checkpoints!: CheckpointManager;
  hooks!: HookRunner;
  cron!: CronScheduler;
  mcp!: McpManager;
  backend!: ExecBackend;
  messaging?: MessagingBridge;
  private agents = new Map<string, Agent>();
  private background = new Set<Promise<unknown>>();
  private agentDefsCache?: { cwd: string; defs: AgentDefinition[] };
  private skillStatsFile: string;

  private constructor(opts: KronosOptions) {
    this.home = opts.home ?? kronosHome();
    this.profile = opts.profile ?? activeProfile(this.home);
    this.paths = profilePaths(profileDir(this.home, this.profile));
    this.cwd = resolvePath(opts.cwd ?? process.cwd(), process.cwd());
    this.skillStatsFile = join(this.paths.root, 'skill-stats.json');
  }

  static async create(opts: KronosOptions = {}): Promise<Kronos> {
    const k = new Kronos(opts);
    ensureDirs(k.paths);
    configureLogger({ level: opts.logLevel, file: join(k.paths.logs, 'kronos.log') });
    k.loadConfig(opts.overrides);
    k.providers = new ProviderRegistry(k.config);
    k.memory = new MemoryStore(k.paths.memories, { memory: k.config.memory.memoryCharLimit, user: k.config.memory.userCharLimit });
    k.skills = new SkillRegistry(k.skillDirs(), k.config.skills.disabled);
    k.sessions = openSessionStore(k.paths.sessionsDb, k.paths.sessionsDir);
    k.artifacts = new ArtifactStore(k.paths.artifacts);
    k.artifacts.onAdd((a) => k.events.emit({ type: 'artifact_added', artifactId: a.id }));
    k.checkpoints = new CheckpointManager(k.paths.checkpoints);
    k.hooks = new HookRunner(k.config.hooks);
    k.backend = createBackend(k.config.terminal, k.workspace());
    k.mcp = new McpManager(k.tools);
    k.tools.registerAll([...fileTools, ...shellTools, ...webTools, ...browserTools, ...agenticTools]);
    k.cron = new CronScheduler(k.paths.cron, (job) => k.runCronJob(job), { timezone: k.config.cron.timezone, maxConcurrent: k.config.cron.maxConcurrent });
    k.cron.on((e) => k.events.emit({ type: 'cron', kind: e.type, job: e.job }));
    if (opts.connectMcp !== false && Object.keys(k.config.mcp.servers).length) await k.mcp.connectAll(k.config.mcp.servers);
    if (opts.startCron && k.config.cron.enabled) k.cron.start();
    return k;
  }

  /** Launch-time overrides (flags, embedding apps, tests) survive every reload. */
  private overrides?: unknown;

  private loadConfig(overrides: unknown = this.overrides): void {
    this.overrides = overrides;
    const loaded = loadConfig({ home: this.home, profileRoot: this.paths.root, cwd: this.cwd, overrides });
    this.config = loaded.config;
    this.rawConfig = loaded.raw;
    this.configFiles = loaded.files;
  }

  /** The configured workspace (terminal.cwd) or the launch directory. */
  workspace(): string {
    return this.config.terminal.cwd ? resolvePath(this.config.terminal.cwd, this.cwd) : this.cwd;
  }

  private skillDirs() {
    return {
      bundled: bundledSkillsDir(),
      user: this.paths.skills,
      project: join(this.cwd, '.kronos', 'skills'),
      extra: this.config.skills.dirs.map((d) => resolvePath(d, this.cwd)),
      claudeCompat: this.config.skills.claudeCompat,
      cwd: this.cwd,
    };
  }

  /** Reload configuration from disk and propagate it to every subsystem. */
  reload(): void {
    this.loadConfig();
    this.providers.updateConfig(this.config);
    this.memory.setLimits({ memory: this.config.memory.memoryCharLimit, user: this.config.memory.userCharLimit });
    this.skills.configure(this.skillDirs(), this.config.skills.disabled);
    this.hooks.update(this.config.hooks);
    this.cron.configure({ timezone: this.config.cron.timezone, maxConcurrent: this.config.cron.maxConcurrent });
    void this.backend.dispose?.();
    this.backend = createBackend(this.config.terminal, this.workspace());
    this.agentDefsCache = undefined;
    this.events.emit({ type: 'config_changed' });
  }

  /** File that holds settings for this profile. */
  configFile(): string {
    return this.profile === 'default' ? this.configFiles.global : (this.configFiles.profile ?? join(this.paths.root, 'config.yaml'));
  }

  updateConfig(patch: Record<string, unknown>): void {
    saveConfigPatch(this.configFile(), patch);
    this.reload();
  }

  setConfig(key: string, value: unknown): void {
    setConfigValue(this.configFile(), key, value);
    this.reload();
  }

  addAllowRule(rule: string): void {
    const allow = [...new Set([...this.rawConfig.safety.allow, rule])];
    this.updateConfig({ safety: { allow } });
  }

  setSkillEnabled(name: string, enabled: boolean): void {
    const disabled = this.skills.setEnabled(name, enabled);
    this.updateConfig({ skills: { disabled } });
  }

  setToolsetEnabled(id: string, enabled: boolean): void {
    const set = new Set(this.rawConfig.toolsets.enabled);
    if (enabled) set.add(id);
    else set.delete(id);
    const disabled = this.rawConfig.toolsets.disabled.filter((t) => t !== id);
    this.updateConfig({ toolsets: { enabled: [...set], disabled } });
  }

  soul(): string | undefined {
    if (existsSync(this.paths.soul)) return readFileSync(this.paths.soul, 'utf8');
    return undefined;
  }

  setSoul(content: string): void {
    writeFileSync(this.paths.soul, content);
  }

  agentDefinitions(cwd = this.cwd): AgentDefinition[] {
    if (this.agentDefsCache?.cwd === cwd) return this.agentDefsCache.defs;
    const defs = loadAgentDefinitions({ userDir: this.paths.agents, cwd, claudeCompat: this.config.skills.claudeCompat });
    this.agentDefsCache = { cwd, defs };
    return defs;
  }

  private updateSkillStats(fn: (stats: Record<string, SkillStats>) => void): void {
    try {
      const stats = this.skillStats();
      fn(stats);
      writeFileSync(this.skillStatsFile, JSON.stringify(stats, null, 2));
    } catch {
      /* best effort */
    }
  }

  recordSkillUse(name: string): void {
    this.updateSkillStats((stats) => {
      const s = (stats[name] ??= { uses: 0, lastUsed: 0, ok: 0, failed: 0 });
      s.uses += 1;
      s.lastUsed = Date.now();
    });
  }

  /** How runs that used these skills ended (clean finish with no failed verification = ok). */
  recordSkillOutcome(names: string[], ok: boolean): void {
    this.updateSkillStats((stats) => {
      for (const name of names) {
        const s = (stats[name] ??= { uses: 0, lastUsed: Date.now(), ok: 0, failed: 0 });
        if (ok) s.ok = (s.ok ?? 0) + 1;
        else s.failed = (s.failed ?? 0) + 1;
      }
    });
  }

  skillStats(): Record<string, SkillStats> {
    try {
      return existsSync(this.skillStatsFile) ? JSON.parse(readFileSync(this.skillStatsFile, 'utf8')) : {};
    } catch {
      return {};
    }
  }

  /**
   * Agent-written skills that stopped earning their place: never or no longer used, or failing
   * more often than not. Components that stop helping get pruned; nothing is deleted here —
   * callers show the list or delete with history kept (`skills.rollback` restores).
   */
  skillPruneCandidates(now = Date.now()): { name: string; reason: string; uses: number; lastUsed: number | null; ok: number; failed: number }[] {
    const stats = this.skillStats();
    const staleMs = this.config.skills.staleAfterDays * 86_400_000;
    const out: { name: string; reason: string; uses: number; lastUsed: number | null; ok: number; failed: number }[] = [];
    for (const skill of this.skills.list({ includeDisabled: true })) {
      if (skill.source !== 'user' || skill.author !== 'kronos') continue;
      const s = stats[skill.name];
      const created = (() => {
        try {
          return statSync(skill.path).birthtimeMs || statSync(skill.path).mtimeMs;
        } catch {
          return now;
        }
      })();
      const lastUsed = s?.lastUsed || null;
      const row = { name: skill.name, uses: s?.uses ?? 0, lastUsed, ok: s?.ok ?? 0, failed: s?.failed ?? 0 };
      if (!lastUsed && now - created > staleMs) out.push({ ...row, reason: `never used in ${this.config.skills.staleAfterDays} days` });
      else if (lastUsed && now - lastUsed > staleMs) out.push({ ...row, reason: `unused for ${Math.floor((now - lastUsed) / 86_400_000)} days` });
      else if (row.ok + row.failed >= 4 && row.failed > row.ok) out.push({ ...row, reason: `runs that used it failed ${row.failed} of ${row.ok + row.failed} times` });
    }
    return out;
  }

  emitAgentEvent(sessionId: string, event: AgentEvent): void {
    this.events.emit({ type: 'agent', sessionId, event });
    if (event.type === 'run_end' || event.type === 'title') this.events.emit({ type: 'session_updated', sessionId });
  }

  // ---------------------------------------------------------------------------
  // Sessions & agents
  // ---------------------------------------------------------------------------

  createSession(init: Partial<SessionRecord> = {}): SessionRecord {
    const cwd = init.cwd ?? this.workspace();
    const s = this.sessions.create({
      profile: this.profile,
      mode: this.config.safety.mode,
      model: init.model ?? '',
      source: 'cli',
      ...init,
      cwd,
    });
    this.events.emit({ type: 'session_updated', sessionId: s.id });
    return s;
  }

  /** Get (or create) the live agent for a session. */
  agent(sessionId: string, opts: Omit<AgentOptions, 'runtime' | 'session'> = {}): Agent {
    const existing = this.agents.get(sessionId);
    if (existing) {
      if (opts.onPermission) existing.opts.onPermission = opts.onPermission;
      if (opts.onClarify) existing.opts.onClarify = opts.onClarify;
      // keep the map in least-recently-used order
      this.agents.delete(sessionId);
      this.agents.set(sessionId, existing);
      return existing;
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const a = new Agent({ ...opts, runtime: this, session });
    this.agents.set(sessionId, a);
    this.evictIdleAgents();
    return a;
  }

  createAgent(opts: Omit<AgentOptions, 'runtime'>): Agent {
    const a = new Agent({ ...opts, runtime: this });
    this.agents.set(opts.session.id, a);
    this.evictIdleAgents();
    return a;
  }

  /**
   * Every open chat keeps a live agent (history, tool specs, caches). Idle ones beyond the cap
   * are dropped, least recently used first; everything they hold is persisted (messages, todos,
   * session allow-rules, Codemaster state), so the next message simply rebuilds the agent.
   */
  private evictIdleAgents(max = Kronos.MAX_IDLE_AGENTS): void {
    let idle = 0;
    for (const a of this.agents.values()) if (!a.isRunning) idle++;
    for (const [id, a] of this.agents) {
      if (idle <= max) break;
      const pending = a.pendingRequests();
      if (a.isRunning || pending.permissions.length || pending.clarify.length) continue;
      this.agents.delete(id);
      idle--;
    }
  }

  static MAX_IDLE_AGENTS = 8;

  liveAgents(): Agent[] {
    return [...this.agents.values()];
  }

  releaseAgent(sessionId: string): void {
    const a = this.agents.get(sessionId);
    if (a && !a.isRunning) this.agents.delete(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.agents.get(sessionId)?.interrupt();
    this.agents.delete(sessionId);
    this.sessions.delete(sessionId);
    this.checkpoints.clear(sessionId);
    this.events.emit({ type: 'session_updated', sessionId });
  }

  /**
   * One-shot, non-interactive run (CLI `kronos run`, cron, API). Returns the final text.
   */
  async runHeadless(
    prompt: string | UserInput,
    opts: { sessionId?: string; model?: string; source?: string; mode?: PermissionMode; autoApprove?: boolean; preloadSkills?: string[]; cwd?: string; title?: string; signal?: AbortSignal; onEvent?: (e: AgentEvent) => void } = {},
  ) {
    // nothing to run with: report it without creating an empty session (a session pinned to the
    // demo model only because nothing was connected follows the default, as in Agent.run)
    const pinned = opts.sessionId ? this.sessions.get(opts.sessionId)?.model : undefined;
    const pinnedRef = pinned && !(pinned.startsWith('kronos:') && !this.providers.demoAllowed(opts.model)) ? pinned : undefined;
    const ready = this.providers.readiness(opts.model ?? pinnedRef);
    if (!ready.ok) {
      return { runId: '', text: '', stopReason: 'error' as const, usage: emptyUsage(), durationMs: 0, error: new NotConnectedError(ready.provider).message, toolCalls: 0, sessionId: opts.sessionId ?? '' };
    }
    const session = opts.sessionId
      ? (this.sessions.get(opts.sessionId) ?? this.createSession({ id: opts.sessionId, source: opts.source ?? 'api', cwd: opts.cwd, title: opts.title }))
      : this.createSession({ source: opts.source ?? 'api', model: opts.model ? this.providers.resolve(opts.model).ref : '', cwd: opts.cwd, title: opts.title, mode: opts.mode ?? this.config.safety.mode });
    const agent = this.agents.get(session.id) ?? this.createAgent({ session, surface: (opts.source ?? 'api').split(':')[0], autoApprove: opts.autoApprove, preloadSkills: opts.preloadSkills });
    if (opts.mode) agent.setMode(opts.mode, false);
    const off = opts.onEvent ? agent.events.on(opts.onEvent) : undefined;
    try {
      const input = typeof prompt === 'string' ? await this.expandInput(prompt, session.cwd) : prompt;
      const res = await agent.run(input, { model: opts.model, signal: opts.signal });
      return { ...res, sessionId: session.id };
    } finally {
      off?.();
      this.releaseAgent(session.id);
    }
  }

  private async runCronJob(job: CronJob): Promise<{ text: string; sessionId?: string }> {
    const res = await this.runHeadless(
      `${job.prompt}\n\n(This is the scheduled automation "${job.name}" — ${job.description}. Run time: ${new Date().toISOString()}.)`,
      {
        source: 'cron',
        model: job.model,
        mode: job.mode ?? 'yolo',
        autoApprove: true,
        preloadSkills: job.skills,
        cwd: job.cwd,
        title: `⏱ ${job.name}`,
      },
    );
    const text = res.error ? `Automation "${job.name}" failed: ${res.error}` : res.text;
    const target = job.deliver?.target;
    if (target && target !== 'session' && text.trim()) {
      const idx = target.indexOf(':');
      const platform = (idx > 0 ? target.slice(0, idx) : target) as PlatformId;
      const to = idx > 0 ? target.slice(idx + 1) : 'home';
      try {
        await this.sendMessage(platform, to, `**⏱ ${job.name}**\n\n${text}`);
      } catch (e) {
        log.error(`cron delivery to ${target} failed`, e);
        throw new Error(`run ok but delivery to ${target} failed: ${(e as Error).message}`);
      }
    }
    if (res.error) throw new Error(res.error);
    return { text, sessionId: res.sessionId };
  }

  async sendMessage(platform: PlatformId, target: string, text: string): Promise<void> {
    let to = target;
    if (!to || to === 'home') {
      const home = (this.config.platforms[platform] as { homeChat?: string } | undefined)?.homeChat;
      if (!home) throw new Error(`No home chat configured for ${platform} (platforms.${platform}.homeChat).`);
      to = home;
    }
    if (this.messaging) return this.messaging(platform, to, text);
    return sendPlatformMessage(platform, to, text, this.config.platforms);
  }

  // ---------------------------------------------------------------------------
  // Slash commands: skills (/skill-name) and custom commands (.kronos/commands/*.md)
  // ---------------------------------------------------------------------------

  private commandDirs(cwd: string): string[] {
    const dirs = [this.paths.commands, join(cwd, '.kronos', 'commands')];
    if (this.config.skills.claudeCompat) dirs.unshift(join(homedir(), '.claude', 'commands'), join(cwd, '.claude', 'commands'));
    return dirs.filter((d) => existsSync(d));
  }

  customCommands(cwd = this.cwd): (CommandInfo & { path: string })[] {
    const out = new Map<string, CommandInfo & { path: string }>();
    for (const dir of this.commandDirs(cwd)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const path = join(dir, f);
        const { data } = parseFrontmatter<Record<string, unknown>>(readFileSync(path, 'utf8'));
        out.set(f.replace(/\.md$/, ''), { name: f.replace(/\.md$/, ''), description: String(data.description ?? ''), source: 'command', path });
      }
    }
    return [...out.values()];
  }

  commands(cwd = this.cwd): CommandInfo[] {
    return [
      ...this.customCommands(cwd).map(({ path: _p, ...c }) => c),
      ...this.skills.list().map((s) => ({ name: s.name, description: s.description, source: 'skill' as const })),
    ];
  }

  /**
   * Expand user input: `/skill args` loads the skill, `/command args` renders a custom command
   * template ($ARGUMENTS, $1..$9), and `@path` mentions attach files or images.
   */
  async expandInput(text: string, cwd = this.cwd): Promise<ExpandedInput> {
    let out = text;
    let command: string | undefined;
    const m = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (m) {
      const name = m[1] as string;
      const args = (m[2] ?? '').trim();
      const custom = this.customCommands(cwd).find((c) => c.name === name);
      const skill = custom ? undefined : this.skills.get(name);
      if (custom) {
        const { body } = parseFrontmatter(readFileSync(custom.path, 'utf8'));
        const argv = args.split(/\s+/).filter(Boolean);
        out = body.replace(/\$ARGUMENTS/g, args).replace(/\$(\d)/g, (_, i: string) => argv[Number(i) - 1] ?? '');
        command = name;
      } else if (skill) {
        const { content } = this.skills.read(skill.name);
        this.recordSkillUse(skill.name);
        out = `<skill name="${skill.name}">\n${content}\n</skill>\n\nUse the skill above for this request${args ? `:\n${args}` : '. Ask me what I need if it is not clear.'}`;
        command = skill.name;
      }
    }
    const files: FilePart[] = [];
    const images: ImagePart[] = [];
    for (const mm of out.matchAll(/(^|\s)@([\w./~-][^\s]*)/g)) {
      const raw = mm[2] as string;
      const path = resolvePath(raw, cwd);
      if (!existsSync(path)) continue;
      try {
        const buf = readFileSync(path);
        const ext = extname(path).toLowerCase();
        const imgType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
        if (imgType) images.push({ type: 'image', mediaType: imgType, data: buf.toString('base64'), name: basename(path) });
        else if (!looksBinary(buf) && buf.length < 400_000) files.push({ type: 'file', name: basename(path), mediaType: 'text/plain', path, text: truncate(buf.toString('utf8'), 200_000), size: buf.length });
      } catch {
        /* ignore unreadable mention */
      }
    }
    return { text: out, files: files.length ? files : undefined, images: images.length ? images : undefined, command, meta: command ? { kind: 'command', command } : undefined };
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  async doctor(): Promise<{ check: string; ok: boolean; detail: string }[]> {
    const { which } = await import('./util/process.js');
    const out: { check: string; ok: boolean; detail: string }[] = [];
    out.push({ check: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.versions.node });
    out.push({ check: 'Kronos home', ok: existsSync(this.home), detail: `${this.home} (profile ${this.profile})` });
    out.push({ check: 'Session store', ok: true, detail: this.sessions.kind === 'sqlite' ? 'SQLite + FTS5' : 'JSON files (upgrade Node for SQLite)' });
    const model = this.providers.resolve();
    out.push({ check: 'Default model', ok: model.provider !== 'kronos', detail: `${model.name} (${model.ref})${model.provider === 'kronos' ? ' — demo mode, add an API key' : ''}` });
    const configured = this.providers.statuses().filter((p) => p.configured && !p.local);
    out.push({ check: 'Providers', ok: configured.length > 0, detail: configured.map((p) => p.label).join(', ') || 'none configured' });
    for (const bin of ['git', 'rg', 'python3', 'docker', 'pdftotext']) {
      const p = await which(bin);
      out.push({ check: bin, ok: Boolean(p), detail: p ?? 'not found (optional)' });
    }
    out.push({ check: 'Skills', ok: true, detail: `${this.skills.list().length} enabled (${Object.keys(this.skills.categories()).length} categories)` });
    out.push({ check: 'MCP servers', ok: this.mcp.status().every((s) => s.status !== 'error'), detail: this.mcp.status().map((s) => `${s.name}:${s.status}`).join(', ') || 'none' });
    out.push({ check: 'Terminal backend', ok: true, detail: this.backend.describe() });
    out.push({ check: 'Browser (Playwright)', ok: this.tools.get('browser')?.available?.(this) === null, detail: this.tools.get('browser')?.available?.(this) ?? 'available' });
    return out;
  }

  /** Track fire-and-forget work (titles, hooks) so close() can wait for it. */
  track<T>(p: Promise<T>): Promise<T> {
    const guarded = p.catch((e) => {
      log.debug('background task failed', e);
      return undefined as T;
    });
    this.background.add(guarded);
    void guarded.finally(() => this.background.delete(guarded));
    return guarded;
  }

  /** Wait for tracked background work (titles, memory extraction, hooks) to finish. */
  async settle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  newRequestId(): string {
    return newId('req_');
  }

  async close(): Promise<void> {
    this.cron.stop();
    for (const a of this.agents.values()) a.interrupt();
    await Promise.race([Promise.allSettled([...this.background]), new Promise((r) => setTimeout(r, 5000))]);
    this.processes.killAll();
    await this.browser.close();
    await this.mcp.closeAll();
    await this.backend.dispose?.();
    this.sessions.close();
  }
}

export function ensureProfile(home: string, name: string): string {
  const dir = profileDir(home, name);
  mkdirSync(dir, { recursive: true });
  ensureDirs(profilePaths(dir));
  return dir;
}
