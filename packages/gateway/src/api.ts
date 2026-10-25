import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';
import type { Kronos, Message, PermissionMode, PlatformId, SessionRecord } from '@kronos/core';
import {
  CONFIG_SECTIONS,
  KRONOS_VERSION,
  PERSONALITIES,
  PROVIDERS,
  listProfiles,
  maskSecrets,
  updateDotenv,
  transcribe,
  textToSpeech,
  resolvePath,
  messagePlainText,
  modelAliases,
  setActiveProfile,
  ensureProfile,
  profileDir,
  PROFILE_NAME_RE,
  defaultConfig,
  describeCron,
  newId,
  parseSchedule,
  readYamlFile,
  writeYamlFile,
} from '@kronos/core';
import { HttpError, Router, sendFile, mimeFor } from './http.js';
import type { Gateway } from './server.js';

const SECRET_ENV_KEYS = [
  ...new Set([
    ...PROVIDERS.flatMap((p) => p.envKeys),
    'TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'SERPER_API_KEY', 'JINA_API_KEY', 'SEARXNG_URL', 'FAL_KEY', 'REPLICATE_API_TOKEN',
    'ELEVENLABS_API_KEY', 'TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'MATRIX_ACCESS_TOKEN',
    'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_VERIFY_TOKEN', 'KRONOS_GATEWAY_TOKEN', 'KRONOS_WEBHOOK_SECRET', 'HASS_TOKEN', 'GITHUB_TOKEN',
  ]),
];

function mask(v: string | undefined): string | null {
  if (!v) return null;
  return v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '••••';
}

function sessionSummary(s: SessionRecord) {
  const { systemPrompt: _p, toolNames: _t, ...rest } = s;
  return rest;
}

export function exportMarkdown(s: SessionRecord, messages: Message[]): string {
  const out: string[] = [`# ${s.title}`, '', `_Exported from Kronos · ${new Date(s.createdAt).toISOString()} · model ${s.model}_`, ''];
  for (const m of messages) {
    if (m.role === 'system') continue;
    for (const p of m.parts) {
      if (p.type === 'text' && p.text.trim()) out.push(`## ${m.role === 'user' ? '🧑 User' : '🤖 Kronos'}`, '', p.text, '');
      else if (p.type === 'tool_call') out.push(`> 🔧 **${p.name}** \`${JSON.stringify(p.input).slice(0, 300)}\``, '');
      else if (p.type === 'tool_result') out.push('<details><summary>result</summary>', '', '```', p.content.slice(0, 4000), '```', '</details>', '');
    }
  }
  return out.join('\n');
}

export function buildApi(gw: Gateway): Router {
  const r = new Router();
  const rt = (): Kronos => gw.rt;

  // ---------------------------------------------------------------- status
  r.get('/api/health', () => ({ ok: true, version: KRONOS_VERSION }));
  r.get('/api/status', () => {
    const k = rt();
    const model = k.providers.resolve();
    return {
      version: KRONOS_VERSION,
      profile: k.profile,
      profiles: listProfiles(k.home),
      home: k.home,
      cwd: k.workspace(),
      model,
      demo: model.provider === 'kronos',
      agentName: k.config.agent.name,
      running: gw.hub.runningList(),
      pending: gw.hub.pending(),
      sessionStore: k.sessions.kind,
      platforms: gw.platforms.statuses(),
      mcp: k.mcp.status(),
      cron: { jobs: k.cron.list().length, enabled: k.config.cron.enabled, next: k.cron.list().find((j) => j.enabled)?.nextRunAt ?? null },
      gateway: { url: gw.url, openaiApi: k.config.gateway.openaiApi, auth: Boolean(gw.token) },
      platform: process.platform,
    };
  });
  r.get('/api/doctor', () => rt().doctor());
  r.get('/api/update', async () => {
    try {
      const res = await fetch('https://api.github.com/repos/burkiuze/KronosAgent/releases/latest', { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { current: KRONOS_VERSION, latest: null, available: false };
      const j = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
      const latest = (j.tag_name ?? '').replace(/^v/, '');
      return { current: KRONOS_VERSION, latest, available: Boolean(latest) && latest !== KRONOS_VERSION, url: j.html_url, notes: j.body };
    } catch {
      return { current: KRONOS_VERSION, latest: null, available: false };
    }
  });

  // ---------------------------------------------------------------- config
  r.get('/api/config', () => ({ config: maskSecrets(rt().rawConfig), sections: CONFIG_SECTIONS, file: rt().configFile(), personalities: Object.entries(PERSONALITIES).map(([id, p]) => ({ id, label: p.label })) }));
  r.patch('/api/config', async (req) => {
    const patch = await req.body<Record<string, unknown>>();
    rt().updateConfig(patch);
    return { config: maskSecrets(rt().rawConfig) };
  });
  r.post('/api/config/reset', () => {
    const f = rt().configFile();
    if (existsSync(f)) renameSync(f, `${f}.${Date.now()}.bak`);
    rt().reload();
    return { config: maskSecrets(rt().rawConfig) };
  });
  r.get('/api/config/export', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8', 'content-disposition': 'attachment; filename="kronos-config.yaml"' });
    res.end(YAML.stringify(rt().rawConfig));
  });
  r.post('/api/config/import', async (req) => {
    const text = (await req.rawBody()).toString('utf8');
    const data = YAML.parse(text) as Record<string, unknown>;
    if (!data || typeof data !== 'object') throw new HttpError(400, 'invalid config');
    const f = rt().configFile();
    if (existsSync(f)) renameSync(f, `${f}.${Date.now()}.bak`);
    writeFileSync(f, YAML.stringify(data));
    rt().reload();
    return { config: maskSecrets(rt().rawConfig) };
  });
  r.get('/api/config/defaults', () => defaultConfig());

  // ---------------------------------------------------------------- keys
  r.get('/api/keys', () => ({
    keys: SECRET_ENV_KEYS.map((name) => ({ name, set: Boolean(process.env[name]), preview: mask(process.env[name]) })),
    file: join(rt().home, '.env'),
  }));
  r.put('/api/keys', async (req) => {
    const { name, value } = await req.body<{ name: string; value: string | null }>();
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new HttpError(400, 'invalid key name');
    updateDotenv(join(rt().home, '.env'), { [name]: value ? value.trim() : null });
    rt().reload();
    return { ok: true, set: Boolean(value) };
  });

  // ---------------------------------------------------------------- models
  r.get('/api/providers', () => rt().providers.statuses());
  r.get('/api/models', async (req) => {
    const p = req.query.get('provider') ?? undefined;
    return { models: await rt().providers.listModels(p), default: rt().providers.resolve(), aliases: modelAliases() };
  });

  // ---------------------------------------------------------------- sessions
  r.get('/api/sessions', (req) =>
    rt()
      .sessions.list({
        query: req.query.get('q') ?? undefined,
        limit: Number(req.query.get('limit') ?? 300),
        project: req.query.get('project') ?? undefined,
        includeArchived: req.query.get('archived') === '1',
        source: req.query.get('source') ?? undefined,
      })
      .map(sessionSummary),
  );
  r.post('/api/sessions', async (req) => {
    const b = await req.body<{ title?: string; cwd?: string; model?: string; mode?: PermissionMode }>();
    const k = rt();
    const s = k.createSession({ source: 'desktop', title: b.title, cwd: b.cwd ? resolvePath(b.cwd, k.cwd) : undefined, model: b.model ? k.providers.resolve(b.model).ref : '', mode: b.mode });
    return sessionSummary(s);
  });
  r.get('/api/sessions/:id', (req) => {
    const k = rt();
    const s = k.sessions.get(req.params.id as string);
    if (!s) throw new HttpError(404, 'session not found');
    const live = k.liveAgents().find((a) => a.id === s.id);
    return {
      session: sessionSummary(s),
      messages: k.sessions.messages(s.id).filter((m) => m.role !== 'system' || m.meta?.kind === 'notice'),
      todos: live?.todos ?? (s.meta.todos as unknown[]) ?? [],
      running: Boolean(live?.isRunning),
      queue: gw.hub.queueOf(s.id),
      context: live?.contextUsage() ?? null,
      checkpoints: k.checkpoints.list(s.id),
      children: k.sessions.list({ includeChildren: true }).filter((c) => c.parentId === s.id).map(sessionSummary),
      systemPrompt: req.query.get('prompt') === '1' ? s.systemPrompt : undefined,
    };
  });
  r.patch('/api/sessions/:id', async (req) => {
    const k = rt();
    const id = req.params.id as string;
    const b = await req.body<{ title?: string; pinned?: boolean; archived?: boolean; model?: string; mode?: PermissionMode; cwd?: string }>();
    if (!k.sessions.get(id)) throw new HttpError(404, 'session not found');
    const agent = k.agent(id);
    if (b.title !== undefined) agent.rename(b.title);
    if (b.model) agent.setModel(b.model);
    if (b.mode) agent.setMode(b.mode);
    const patch: Partial<SessionRecord> = {};
    if (b.pinned !== undefined) patch.pinned = b.pinned;
    if (b.archived !== undefined) patch.archived = b.archived;
    if (b.cwd) patch.cwd = resolvePath(b.cwd, k.cwd);
    if (Object.keys(patch).length) k.sessions.update(id, patch);
    k.events.emit({ type: 'session_updated', sessionId: id });
    return sessionSummary(k.sessions.get(id) as SessionRecord);
  });
  r.delete('/api/sessions/:id', (req) => {
    rt().deleteSession(req.params.id as string);
    return { ok: true };
  });
  r.post('/api/sessions/:id/undo', (req) => {
    const res = rt().agent(req.params.id as string).undo();
    rt().events.emit({ type: 'session_updated', sessionId: req.params.id as string });
    return res ?? { removed: 0, restoredFiles: [], text: '' };
  });
  r.post('/api/sessions/:id/compact', async (req) => rt().agent(req.params.id as string).compact());
  r.post('/api/sessions/:id/refresh', (req) => {
    rt().agent(req.params.id as string).refreshContext();
    return { ok: true };
  });
  r.post('/api/sessions/:id/fork', async (req) => {
    const k = rt();
    const src = k.sessions.get(req.params.id as string);
    if (!src) throw new HttpError(404, 'session not found');
    const b = await req.body<{ upTo?: number }>();
    const msgs = k.sessions.messages(src.id);
    const keep = b.upTo !== undefined ? msgs.slice(0, b.upTo) : msgs;
    const s = k.createSession({ source: 'desktop', title: `${src.title} (fork)`, cwd: src.cwd, model: src.model, mode: src.mode, systemPrompt: src.systemPrompt, toolNames: src.toolNames });
    k.sessions.appendMessages(s.id, keep.map((m) => ({ ...m, id: newId('m_') })));
    return sessionSummary(k.sessions.get(s.id) as SessionRecord);
  });
  r.get('/api/sessions/:id/export', (req, res) => {
    const k = rt();
    const s = k.sessions.get(req.params.id as string);
    if (!s) throw new HttpError(404, 'session not found');
    const msgs = k.sessions.messages(s.id);
    const fmt = req.query.get('format') ?? 'md';
    const name = s.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'session';
    if (fmt === 'json') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${name}.json"` });
      res.end(JSON.stringify({ session: sessionSummary(s), messages: msgs }, null, 2));
    } else {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${name}.md"` });
      res.end(exportMarkdown(s, msgs));
    }
  });
  r.get('/api/search', (req) => {
    const q = req.query.get('q') ?? '';
    if (!q.trim()) return [];
    return rt().sessions.search(q, { limit: Number(req.query.get('limit') ?? 30) });
  });
  r.get('/api/projects', () => {
    const counts: Record<string, number> = {};
    for (const s of rt().sessions.list({ limit: 2000 })) counts[s.project] = (counts[s.project] ?? 0) + 1;
    return Object.entries(counts).map(([name, count]) => ({ name, count }));
  });

  // ---------------------------------------------------------------- chat (REST alternative to WS)
  r.post('/api/chat', async (req) => {
    const b = await req.body<{ sessionId?: string; text: string; model?: string; mode?: PermissionMode; wait?: boolean }>();
    if (b.wait) {
      const res = await rt().runHeadless(b.text, { sessionId: b.sessionId, model: b.model, mode: b.mode, source: 'api' });
      return res;
    }
    return gw.hub.chat({ sessionId: b.sessionId, text: b.text, model: b.model, mode: b.mode, source: 'api' });
  });
  r.post('/api/sessions/:id/stop', (req) => {
    gw.hub.stop(req.params.id as string);
    return { ok: true };
  });

  // ---------------------------------------------------------------- skills & tools
  r.get('/api/skills', () => {
    const k = rt();
    const stats = k.skillStats();
    return {
      skills: k.skills.list({ includeDisabled: true }).map((s) => ({ ...s, uses: stats[s.name]?.uses ?? 0, lastUsed: stats[s.name]?.lastUsed ?? null })),
      categories: k.skills.categories(),
      userDir: k.paths.skills,
    };
  });
  r.get('/api/skills/:name', (req) => {
    const k = rt();
    const info = k.skills.get(req.params.name as string);
    if (!info) throw new HttpError(404, 'skill not found');
    return { info, content: readFileSync(info.path, 'utf8') };
  });
  r.patch('/api/skills/:name', async (req) => {
    const b = await req.body<{ enabled?: boolean }>();
    if (b.enabled !== undefined) rt().setSkillEnabled(req.params.name as string, b.enabled);
    return rt().skills.get(req.params.name as string) ?? { ok: true };
  });
  r.post('/api/skills', async (req) => {
    const b = await req.body<{ name: string; description: string; body: string; category?: string; tags?: string[] }>();
    return rt().skills.create(b);
  });
  r.put('/api/skills/:name', async (req) => {
    const b = await req.body<{ description?: string; body?: string }>();
    return rt().skills.update(req.params.name as string, b);
  });
  r.delete('/api/skills/:name', (req) => {
    rt().skills.delete(req.params.name as string);
    return { ok: true };
  });
  r.post('/api/skills/install', async (req) => {
    const b = await req.body<{ source: string; category?: string }>();
    return rt().skills.install(b.source, { category: b.category });
  });
  r.get('/api/toolsets', () => rt().tools.status(rt(), rt().config.toolsets.enabled));
  r.patch('/api/toolsets/:id', async (req) => {
    const b = await req.body<{ enabled: boolean }>();
    rt().setToolsetEnabled(req.params.id as string, b.enabled);
    return rt().tools.status(rt(), rt().config.toolsets.enabled).find((t) => t.id === req.params.id);
  });
  r.get('/api/commands', () => rt().commands());
  r.get('/api/agents', () => rt().agentDefinitions());

  // ---------------------------------------------------------------- artifacts
  r.get('/api/artifacts', (req) => {
    const kind = req.query.get('kind') as 'file' | 'image' | 'link' | null;
    return { items: rt().artifacts.list({ kind: kind ?? undefined, query: req.query.get('q') ?? undefined, sessionId: req.query.get('session') ?? undefined }), counts: rt().artifacts.counts() };
  });
  r.delete('/api/artifacts/:id', (req) => ({ ok: rt().artifacts.remove(req.params.id as string) }));
  r.get('/api/artifacts/:id/file', (req, res) => {
    const a = rt().artifacts.list().find((x) => x.id === req.params.id);
    if (!a || a.kind === 'link') throw new HttpError(404, 'artifact not found');
    if (!existsSync(a.location)) throw new HttpError(404, 'file no longer exists');
    sendFile(res, a.location, { download: req.query.get('download') === '1' });
  });

  // ---------------------------------------------------------------- files panel
  r.get('/api/files', (req) => {
    const k = rt();
    const dir = resolvePath(req.query.get('path') || k.workspace(), k.cwd);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new HttpError(404, 'directory not found');
    const hidden = req.query.get('hidden') === '1';
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => hidden || !e.name.startsWith('.'))
      .map((e) => {
        let size = 0;
        let mtime = 0;
        try {
          const st = statSync(join(dir, e.name));
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          /* broken link */
        }
        return { name: e.name, path: join(dir, e.name), dir: e.isDirectory(), size, mtime };
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { path: dir, parent: dirname(dir) !== dir ? dirname(dir) : null, home: homedir(), entries };
  });
  r.get('/api/files/read', (req, res) => {
    const p = resolvePath(req.query.get('path') ?? '', rt().cwd);
    if (!existsSync(p) || statSync(p).isDirectory()) throw new HttpError(404, 'file not found');
    if (req.query.get('raw') === '1') return sendFile(res, p, { download: req.query.get('download') === '1' });
    const st = statSync(p);
    const mime = mimeFor(p);
    if (st.size > 2_000_000 || (!mime.startsWith('text') && !/json|javascript|xml|yaml|svg/.test(mime) && !/\.(ts|tsx|py|go|rs|java|c|h|cpp|rb|sh|toml|ini|cfg|env|md|txt|log|sql|vue|svelte|kt|swift|php|lua|r|dart|gradle|lock)$/i.test(p))) {
      return { path: p, binary: true, size: st.size, mime };
    }
    return { path: p, content: readFileSync(p, 'utf8'), size: st.size, mime };
  });
  r.put('/api/files/write', async (req) => {
    const b = await req.body<{ path: string; content: string }>();
    const p = resolvePath(b.path, rt().cwd);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, b.content);
    return { ok: true, path: p };
  });
  r.post('/api/files/upload', async (req) => {
    const name = basename(req.query.get('name') ?? 'upload.bin').replace(/[^\w.-]+/g, '_');
    const dir = resolvePath(req.query.get('dir') ?? join(rt().paths.root, 'uploads'), rt().cwd);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${Date.now().toString(36)}-${name}`);
    writeFileSync(p, await req.rawBody());
    return { path: p };
  });

  // ---------------------------------------------------------------- memory & persona
  r.get('/api/memory', () => {
    const m = rt().memory;
    return {
      memory: { entries: m.entries('memory'), usage: m.usage('memory') },
      user: { entries: m.entries('user'), usage: m.usage('user') },
      changes: m.changes(40),
    };
  });
  r.put('/api/memory/:target', async (req) => {
    const target = req.params.target === 'user' ? 'user' : 'memory';
    const b = await req.body<{ entries: string[] }>();
    const res = rt().memory.replaceAll(target, b.entries);
    if (!res.ok) throw new HttpError(400, res.message);
    return res;
  });
  r.get('/api/soul', () => ({ content: rt().soul() ?? '', path: rt().paths.soul }));
  r.put('/api/soul', async (req) => {
    const b = await req.body<{ content: string }>();
    rt().setSoul(b.content);
    return { ok: true };
  });

  // ---------------------------------------------------------------- profiles
  r.get('/api/profiles', () => {
    const k = rt();
    return listProfiles(k.home).map((name) => {
      const dir = profileDir(k.home, name);
      const soul = join(dir, 'SOUL.md');
      return { name, active: name === k.profile, dir, soul: existsSync(soul) ? readFileSync(soul, 'utf8').slice(0, 280) : '' };
    });
  });
  r.post('/api/profiles', async (req) => {
    const b = await req.body<{ name: string; copyFrom?: string; soul?: string }>();
    if (!PROFILE_NAME_RE.test(b.name)) throw new HttpError(400, 'profile names use letters, digits, - and _');
    const k = rt();
    const dir = ensureProfile(k.home, b.name);
    if (b.copyFrom) {
      const src = profileDir(k.home, b.copyFrom);
      for (const f of ['SOUL.md', 'memories', 'skills', 'agents', 'commands']) {
        const p = join(src, f);
        if (existsSync(p)) cpSync(p, join(dir, f), { recursive: true });
      }
      const cfg = b.copyFrom === 'default' ? join(src, 'config.yaml') : join(src, 'config.yaml');
      if (existsSync(cfg) && b.copyFrom !== 'default') cpSync(cfg, join(dir, 'config.yaml'));
    }
    if (b.soul) writeFileSync(join(dir, 'SOUL.md'), b.soul);
    return { name: b.name, dir };
  });
  r.post('/api/profiles/:name/activate', async (req) => {
    const name = req.params.name as string;
    if (!listProfiles(rt().home).includes(name)) throw new HttpError(404, 'profile not found');
    setActiveProfile(rt().home, name);
    await gw.switchProfile(name);
    return { profile: name };
  });
  r.delete('/api/profiles/:name', (req) => {
    const name = req.params.name as string;
    if (name === 'default') throw new HttpError(400, 'cannot delete the default profile');
    if (name === rt().profile) throw new HttpError(400, 'switch to another profile first');
    rmSync(profileDir(rt().home, name), { recursive: true, force: true });
    return { ok: true };
  });

  // ---------------------------------------------------------------- automations
  r.get('/api/cron', () => ({ jobs: rt().cron.list().map((j) => ({ ...j, running: rt().cron.isRunning(j.id) })), history: rt().cron.history(undefined, 50) }));
  r.post('/api/cron', async (req) => {
    const b = await req.body<{ name?: string; schedule: string; prompt: string; deliver?: string; model?: string; mode?: PermissionMode }>();
    return rt().cron.create({ name: b.name, schedule: b.schedule, prompt: b.prompt, model: b.model, mode: b.mode, deliver: b.deliver ? { target: b.deliver } : undefined, cwd: rt().workspace() });
  });
  r.patch('/api/cron/:id', async (req) => {
    const b = await req.body<{ name?: string; schedule?: string; prompt?: string; enabled?: boolean; deliver?: string; model?: string }>();
    return rt().cron.update(req.params.id as string, { ...b, deliver: b.deliver !== undefined ? { target: b.deliver || undefined } : undefined });
  });
  r.delete('/api/cron/:id', (req) => ({ ok: rt().cron.remove(req.params.id as string) }));
  r.post('/api/cron/:id/run', (req) => {
    void rt().cron.run(req.params.id as string).catch(() => undefined);
    return { ok: true };
  });
  r.get('/api/cron/describe', (req) => {
    try {
      const p = parseSchedule(req.query.get('s') ?? '');
      return { ok: true, ...p, description: p.cron ? describeCron(p.cron) : p.description };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // ---------------------------------------------------------------- MCP
  r.get('/api/mcp', () => ({ servers: rt().mcp.status(), config: maskSecrets(rt().rawConfig.mcp.servers) }));
  r.post('/api/mcp', async (req) => {
    const b = await req.body<{ name: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string> }>();
    if (!/^[\w-]{1,40}$/.test(b.name)) throw new HttpError(400, 'invalid server name');
    const { name, ...cfg } = b;
    rt().updateConfig({ mcp: { servers: { [name]: { ...cfg, enabled: true } } } });
    return rt().mcp.connect(name, rt().config.mcp.servers[name] ?? cfg);
  });
  r.delete('/api/mcp/:name', async (req) => {
    const name = req.params.name as string;
    await rt().mcp.disconnect(name);
    const servers = { ...rt().rawConfig.mcp.servers };
    delete servers[name];
    const f = rt().configFile();
    const data = readYamlFile(f) as { mcp?: { servers?: Record<string, unknown> } };
    if (data.mcp?.servers) delete data.mcp.servers[name];
    writeYamlFile(f, data);
    rt().reload();
    return { ok: true };
  });
  r.post('/api/mcp/:name/reconnect', async (req) => {
    const name = req.params.name as string;
    const cfg = rt().config.mcp.servers[name];
    if (!cfg) throw new HttpError(404, 'unknown server');
    await rt().mcp.disconnect(name);
    return rt().mcp.connect(name, cfg);
  });

  // ---------------------------------------------------------------- messaging
  r.get('/api/platforms', () => ({ platforms: gw.platforms.statuses(), pairing: gw.platforms.pairingRequests() }));
  r.post('/api/platforms/:id/start', async (req) => {
    const id = req.params.id as PlatformId;
    rt().updateConfig({ platforms: { [id]: { enabled: true } } });
    return gw.platforms.start(id);
  });
  r.post('/api/platforms/:id/stop', async (req) => {
    const id = req.params.id as PlatformId;
    rt().updateConfig({ platforms: { [id]: { enabled: false } } });
    await gw.platforms.stop(id);
    return gw.platforms.statusOf(id);
  });
  r.post('/api/platforms/:id/test', async (req) => {
    const b = await req.body<{ target?: string; text?: string }>();
    await rt().sendMessage(req.params.id as PlatformId, b.target ?? 'home', b.text ?? '👋 Hello from Kronos!');
    return { ok: true };
  });
  r.post('/api/pairing/:code/approve', (req) => gw.platforms.approvePairing(req.params.code as string));
  r.post('/api/pairing/:code/deny', (req) => {
    gw.platforms.denyPairing(req.params.code as string);
    return { ok: true };
  });

  // ---------------------------------------------------------------- usage & insights
  r.get('/api/usage', (req) => {
    const days = Number(req.query.get('days') ?? 30);
    const since = Date.now() - days * 86400_000;
    const k = rt();
    const byDay = k.sessions.usageSummary({ since, groupBy: 'day' });
    const byModel = k.sessions.usageSummary({ since, groupBy: 'model' });
    const bySource = k.sessions.usageSummary({ since, groupBy: 'source' });
    const total = byDay.reduce(
      (a, r2) => ({
        inputTokens: a.inputTokens + r2.inputTokens,
        outputTokens: a.outputTokens + r2.outputTokens,
        cacheReadTokens: a.cacheReadTokens + r2.cacheReadTokens,
        costUsd: a.costUsd + r2.costUsd,
        requests: a.requests + r2.requests,
        toolCalls: a.toolCalls + r2.toolCalls,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, requests: 0, toolCalls: 0 },
    );
    const sessions = k.sessions.list({ limit: 5000, includeChildren: true }).filter((s) => s.updatedAt >= since);
    const skills = Object.entries(k.skillStats())
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 10);
    return { days, total, byDay, byModel, bySource, sessions: sessions.length, subagents: sessions.filter((s) => s.parentId).length, skills, memory: { memory: k.memory.usage('memory'), user: k.memory.usage('user') } };
  });

  // ---------------------------------------------------------------- voice
  r.post('/api/voice/transcribe', async (req) => {
    const audio = await req.rawBody();
    const text = await transcribe(audio, String(req.headers['content-type'] ?? 'audio/webm'), rt().config.voice);
    return { text };
  });
  r.post('/api/voice/speak', async (req, res) => {
    const b = await req.body<{ text: string; voice?: string }>();
    const out = await textToSpeech(b.text, rt().config.voice, join(rt().paths.cache, 'tts'), { voice: b.voice });
    res.writeHead(200, { 'content-type': out.mediaType });
    res.end(out.data);
  });

  // ---------------------------------------------------------------- misc
  r.get('/api/fs/home', () => ({ home: homedir(), cwd: rt().workspace() }));
  r.get('/api/fs/resolve', (req) => ({ path: resolve(resolvePath(req.query.get('path') ?? '.', rt().cwd)) }));
  r.get('/api/transcript/:id', (req) => rt().sessions.messages(req.params.id as string).map((m) => ({ role: m.role, text: messagePlainText(m) })));

  return r;
}
