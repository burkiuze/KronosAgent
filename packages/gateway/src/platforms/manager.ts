import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kronos, PermissionDecision, PermissionMode, PlatformId } from '@kronos/core';
import { PLATFORM_LABELS, platformConfigured, transcribe, logger, errorMessage, formatTokens, formatCost } from '@kronos/core';
import type { IncomingMessage, PlatformAdapter, PlatformContext, PlatformStatus } from './base.js';
import { TelegramAdapter } from './telegram.js';
import { DiscordAdapter } from './discord.js';
import { SlackAdapter } from './slack.js';
import { MatrixAdapter, SignalAdapter, WhatsAppAdapter, WebhookAdapter } from './others.js';

const log = logger('platforms');

export interface PairingRequest {
  code: string;
  platform: PlatformId;
  userId: string;
  userName?: string;
  chatId: string;
  createdAt: number;
}

interface ChatState {
  queue: IncomingMessage[];
  pendingPermission?: { requestId: string; resolve: (d: PermissionDecision) => void };
  pendingClarify?: { resolve: (a: string) => void };
}

const HELP = `*Kronos commands*
/new — fresh conversation
/stop — stop the current task
/status — session, model, usage
/model [name] — show or switch model (e.g. /model sonnet)
/mode [ask|auto-edit|yolo|plan] — permission mode
/undo — undo the last turn
/retry — redo the last turn
/compact — compress the conversation
/sethome — deliver automations to this chat
/approve, /always, /deny — answer approval requests`;

/** Runs every enabled messaging adapter and turns chat messages into agent runs. */
export class PlatformManager {
  private adapters = new Map<PlatformId, PlatformAdapter>();
  private chats = new Map<string, ChatState>();
  private pairing: PairingRequest[] = [];
  private sessionMap: Record<string, string> = {};

  constructor(private getRt: () => Kronos) {
    this.loadMap();
  }

  private get rt(): Kronos {
    return this.getRt();
  }

  private mapFile(): string {
    return join(this.rt.paths.root, 'platform-sessions.json');
  }

  private loadMap(): void {
    try {
      if (existsSync(this.mapFile())) this.sessionMap = JSON.parse(readFileSync(this.mapFile(), 'utf8'));
    } catch {
      this.sessionMap = {};
    }
  }

  private saveMap(): void {
    writeFileSync(this.mapFile(), JSON.stringify(this.sessionMap, null, 2));
  }

  private create(id: PlatformId): PlatformAdapter | undefined {
    switch (id) {
      case 'telegram':
        return new TelegramAdapter();
      case 'discord':
        return new DiscordAdapter();
      case 'slack':
        return new SlackAdapter();
      case 'matrix':
        return new MatrixAdapter();
      case 'signal':
        return new SignalAdapter();
      case 'whatsapp':
        return new WhatsAppAdapter();
      case 'webhook':
        return new WebhookAdapter();
      default:
        return undefined;
    }
  }

  get(id: PlatformId): PlatformAdapter | undefined {
    return this.adapters.get(id);
  }

  async startAll(): Promise<void> {
    this.loadMap();
    const cfg = this.rt.config.platforms;
    for (const id of Object.keys(PLATFORM_LABELS) as PlatformId[]) {
      const pc = cfg[id] as { enabled?: boolean } | undefined;
      if (!pc?.enabled) continue;
      await this.start(id).catch((e) => log.warn(`${id} failed to start: ${errorMessage(e)}`));
    }
  }

  async start(id: PlatformId): Promise<PlatformStatus> {
    await this.stop(id);
    const adapter = this.create(id);
    if (!adapter) throw new Error(`${id} has no inbound adapter (outbound only)`);
    this.adapters.set(id, adapter);
    const ctx: PlatformContext = {
      runtime: () => this.rt,
      onMessage: (m) => this.onMessage(adapter, m),
      log: (t) => log.warn(t),
    };
    await adapter.start(ctx);
    log.info(`${id} connected as ${adapter.botName ?? '?'}`);
    return this.statusOf(id);
  }

  async stop(id: PlatformId): Promise<void> {
    const a = this.adapters.get(id);
    if (a) await a.stop().catch(() => undefined);
    this.adapters.delete(id);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.adapters.keys()]) await this.stop(id);
  }

  statusOf(id: PlatformId): PlatformStatus {
    const cfg = this.rt.config.platforms;
    const a = this.adapters.get(id);
    const pc = cfg[id] as { enabled?: boolean };
    return {
      id,
      label: PLATFORM_LABELS[id],
      state: a ? a.state : pc?.enabled ? 'stopped' : 'disabled',
      detail: a?.detail,
      botName: a?.botName,
      configured: platformConfigured(id, cfg),
      enabled: Boolean(pc?.enabled),
      messages: a?.messages ?? 0,
    };
  }

  statuses(): PlatformStatus[] {
    return (Object.keys(PLATFORM_LABELS) as PlatformId[]).map((id) => this.statusOf(id));
  }

  pairingRequests(): PairingRequest[] {
    return [...this.pairing];
  }

  approvePairing(code: string): PairingRequest {
    const req = this.pairing.find((p) => p.code === code.toUpperCase());
    if (!req) throw new Error(`no pairing request ${code}`);
    const allowed = new Set(((this.rt.rawConfig.platforms[req.platform] as { allowedUsers?: string[] }).allowedUsers ?? []).map(String));
    allowed.add(req.userId);
    this.rt.updateConfig({ platforms: { [req.platform]: { allowedUsers: [...allowed] } } });
    this.pairing = this.pairing.filter((p) => p !== req);
    void this.adapters.get(req.platform)?.send(req.chatId, '✅ Paired! You can talk to me now.').catch(() => undefined);
    return req;
  }

  denyPairing(code: string): void {
    this.pairing = this.pairing.filter((p) => p.code !== code.toUpperCase());
  }

  /** Outbound bridge for the runtime (send_message tool, cron delivery). */
  async send(platform: PlatformId, target: string, text: string): Promise<void> {
    const a = this.adapters.get(platform);
    if (a) return a.send(target, text);
    const { sendPlatformMessage } = await import('@kronos/core');
    return sendPlatformMessage(platform, target, text, this.rt.config.platforms);
  }

  private chatKey(m: IncomingMessage): string {
    return `${m.platform}:${m.chatId}`;
  }

  private state(key: string): ChatState {
    let s = this.chats.get(key);
    if (!s) {
      s = { queue: [] };
      this.chats.set(key, s);
    }
    return s;
  }

  private authorized(m: IncomingMessage): boolean {
    const allowed = ((this.rt.config.platforms[m.platform] as { allowedUsers?: string[] }).allowedUsers ?? []).map(String);
    return allowed.includes('*') || allowed.includes(m.userId) || (m.userName !== undefined && allowed.includes(m.userName));
  }

  sessionFor(m: IncomingMessage, fresh = false): string {
    const key = this.chatKey(m);
    const existing = this.sessionMap[key];
    if (!fresh && existing && this.rt.sessions.get(existing)) return existing;
    const pc = this.rt.config.platforms[m.platform] as { mode?: PermissionMode };
    const s = this.rt.createSession({ source: key, title: `${PLATFORM_LABELS[m.platform]} · ${m.userName ?? m.chatId}`, mode: pc.mode ?? 'auto-edit' });
    this.sessionMap[key] = s.id;
    this.saveMap();
    return s.id;
  }

  private async reply(adapter: PlatformAdapter, m: IncomingMessage, text: string): Promise<void> {
    await adapter.send(m.chatId, text).catch((e) => log.warn(`reply failed: ${errorMessage(e)}`));
  }

  async onMessage(adapter: PlatformAdapter, m: IncomingMessage): Promise<void> {
    const rt = this.rt;
    if (!this.authorized(m)) {
      let req = this.pairing.find((p) => p.platform === m.platform && p.userId === m.userId);
      if (!req) {
        req = { code: Math.random().toString(36).slice(2, 8).toUpperCase(), platform: m.platform, userId: m.userId, userName: m.userName, chatId: m.chatId, createdAt: Date.now() };
        this.pairing.push(req);
      }
      await this.reply(adapter, m, `🔒 This Kronos agent is private.\nPairing code: *${req.code}*\nApprove it in Kronos Desktop → Messaging, or run \`kronos pairing approve ${req.code}\`.`);
      return;
    }
    const key = this.chatKey(m);
    const st = this.state(key);

    if (m.audio && !m.text) {
      try {
        m.text = await transcribe(m.audio.data, m.audio.mediaType, rt.config.voice);
        if (m.text) await this.reply(adapter, m, `🎤 _${m.text}_`);
      } catch (e) {
        await this.reply(adapter, m, `I received a voice message but could not transcribe it: ${errorMessage(e)}`);
        return;
      }
    }
    const text = (m.text ?? '').trim();

    // answers to pending approvals / questions
    if (st.pendingPermission) {
      const map: Record<string, PermissionDecision['decision']> = { '/approve': 'allow', '/yes': 'allow', yes: 'allow', y: 'allow', '/always': 'allow_session', '/deny': 'deny', '/no': 'deny', no: 'deny', n: 'deny' };
      const d = map[text.toLowerCase()];
      if (d) {
        const p = st.pendingPermission;
        st.pendingPermission = undefined;
        p.resolve(d === 'deny' ? { decision: 'deny' } : { decision: d });
        return;
      }
    }
    if (st.pendingClarify && !text.startsWith('/')) {
      const p = st.pendingClarify;
      st.pendingClarify = undefined;
      p.resolve(text);
      return;
    }

    if (text.startsWith('/')) {
      const handled = await this.command(adapter, m, text);
      if (handled) return;
    }
    if (!text && !m.images?.length) return;

    const sessionId = this.sessionFor(m);
    const agent = rt.agent(sessionId, {
      surface: m.platform,
      onPermission: (req) =>
        new Promise<PermissionDecision>((resolve) => {
          st.pendingPermission = { requestId: req.requestId, resolve };
          void this.reply(
            adapter,
            m,
            `⚠️ *Approval needed*${req.dangerous ? ' (dangerous)' : ''}\n${req.summary}\n_${req.reason}_\n\nReply /approve, /always (this session) or /deny`,
          );
          setTimeout(() => {
            if (st.pendingPermission?.requestId === req.requestId) {
              st.pendingPermission = undefined;
              resolve({ decision: 'deny', feedback: 'no answer in time' });
            }
          }, 30 * 60 * 1000).unref();
        }),
      onClarify: (req) =>
        new Promise<string>((resolve) => {
          st.pendingClarify = { resolve };
          void this.reply(adapter, m, `❓ ${req.question}${req.options?.length ? `\n${req.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : ''}`);
        }),
    });
    if (agent.isRunning) {
      st.queue.push(m);
      await this.reply(adapter, m, '⏳ Queued — I will get to it after the current task. Send /stop to interrupt.');
      return;
    }
    await this.runFor(adapter, m, sessionId);
  }

  private async runFor(adapter: PlatformAdapter, m: IncomingMessage, sessionId: string): Promise<void> {
    const rt = this.rt;
    const key = this.chatKey(m);
    const st = this.state(key);
    const agent = rt.agent(sessionId);
    const typing = setInterval(() => void adapter.typing(m.chatId), 4500);
    void adapter.typing(m.chatId);
    try {
      const expanded = await rt.expandInput(m.text ?? '', agent.session.cwd);
      const res = await agent.run({
        text: `${m.isGroup && m.userName ? `[${m.userName}] ` : ''}${expanded.text}`,
        images: [...(m.images ?? []), ...(expanded.images ?? [])],
        files: expanded.files,
        meta: { kind: 'platform', source: key, author: m.userName },
      });
      if (res.stopReason === 'interrupted') await this.reply(adapter, m, '⏹ Stopped.');
      else if (res.error) await this.reply(adapter, m, `⚠️ ${res.error}`);
      else if (res.text.trim()) await this.reply(adapter, m, res.text);
    } catch (e) {
      await this.reply(adapter, m, `⚠️ ${errorMessage(e)}`);
    } finally {
      clearInterval(typing);
    }
    const next = st.queue.shift();
    if (next) await this.runFor(adapter, next, sessionId);
  }

  private async command(adapter: PlatformAdapter, m: IncomingMessage, text: string): Promise<boolean> {
    const rt = this.rt;
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();
    const key = this.chatKey(m);
    const st = this.state(key);
    const sessionId = this.sessionMap[key];
    const agent = sessionId && rt.sessions.get(sessionId) ? rt.agent(sessionId) : undefined;
    switch ((cmd ?? '').toLowerCase()) {
      case '/start':
      case '/help':
        await this.reply(adapter, m, `👋 I'm ${rt.config.agent.name}.\n\n${HELP}`);
        return true;
      case '/new':
      case '/reset':
        agent?.interrupt();
        st.queue = [];
        this.sessionFor(m, true);
        await this.reply(adapter, m, '🆕 Fresh conversation started.');
        return true;
      case '/stop':
        st.queue = [];
        agent?.interrupt();
        if (!agent?.isRunning) await this.reply(adapter, m, 'Nothing is running.');
        return true;
      case '/status': {
        const s = sessionId ? rt.sessions.get(sessionId) : undefined;
        const model = rt.providers.resolve(s?.model || undefined);
        const ctx = agent?.contextUsage();
        await this.reply(
          adapter,
          m,
          `*Status*\nModel: ${model.name}\nMode: ${agent?.mode ?? rt.config.safety.mode}\nRunning: ${agent?.isRunning ? 'yes' : 'no'}\nMessages: ${s?.messageCount ?? 0}\nTokens: ${formatTokens((s?.usage.inputTokens ?? 0) + (s?.usage.outputTokens ?? 0))} · ${formatCost(s?.usage.costUsd ?? 0)}${ctx ? `\nContext: ${ctx.percent}%` : ''}`,
        );
        return true;
      }
      case '/model': {
        if (!arg) {
          const s = sessionId ? rt.sessions.get(sessionId) : undefined;
          await this.reply(adapter, m, `Current model: ${rt.providers.resolve(s?.model || undefined).ref}`);
          return true;
        }
        const id = this.sessionFor(m);
        const info = rt.agent(id).setModel(arg);
        await this.reply(adapter, m, `Model set to ${info.name} (${info.ref}).`);
        return true;
      }
      case '/mode': {
        const modes = ['ask', 'auto-edit', 'yolo', 'plan'];
        if (!modes.includes(arg)) {
          await this.reply(adapter, m, `Usage: /mode ${modes.join('|')}`);
          return true;
        }
        rt.agent(this.sessionFor(m)).setMode(arg as PermissionMode);
        await this.reply(adapter, m, `Mode: ${arg}`);
        return true;
      }
      case '/undo': {
        const u = agent?.undo();
        await this.reply(adapter, m, u ? `↩️ Undid the last turn${u.restoredFiles.length ? ` and restored ${u.restoredFiles.length} file(s)` : ''}.` : 'Nothing to undo.');
        return true;
      }
      case '/retry': {
        if (!agent) return true;
        const u = agent.undo();
        if (!u) {
          await this.reply(adapter, m, 'Nothing to retry.');
          return true;
        }
        await this.runFor(adapter, { ...m, text: u.text }, agent.id);
        return true;
      }
      case '/compact': {
        if (!agent) return true;
        const r = await agent.compact();
        await this.reply(adapter, m, `🗜 Compacted ~${formatTokens(r.before)} → ~${formatTokens(r.after)} tokens.`);
        return true;
      }
      case '/sethome':
        rt.updateConfig({ platforms: { [m.platform]: { homeChat: m.chatId } } });
        await this.reply(adapter, m, '🏠 This chat will receive automation results.');
        return true;
      default:
        return false; // let skills / custom commands through
    }
  }

  /** Handle a synchronous webhook request (POST /hooks/webhook). */
  async webhook(body: { text?: string; chat?: string; user?: string; model?: string }): Promise<{ text: string; sessionId: string }> {
    const rt = this.rt;
    const chat = body.chat ?? 'default';
    const key = `webhook:${chat}`;
    let sessionId = this.sessionMap[key];
    if (!sessionId || !rt.sessions.get(sessionId)) {
      sessionId = rt.createSession({ source: key, title: `Webhook · ${chat}` }).id;
      this.sessionMap[key] = sessionId;
      this.saveMap();
    }
    const res = await rt.runHeadless(body.text ?? '', { sessionId, source: key, model: body.model, autoApprove: false });
    return { text: res.text || res.error || '', sessionId };
  }
}
