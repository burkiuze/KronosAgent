import WebSocket from 'ws';
import { sendPlatformMessage } from '@kronos/core';
import { PlatformAdapter, downloadBuffer, sleepMs } from './base.js';

interface SlackEvent {
  type: string;
  subtype?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
  files?: { url_private: string; mimetype: string }[];
}

/** Slack app via Socket Mode (xapp- app token + xoxb- bot token; no public URL needed). */
export class SlackAdapter extends PlatformAdapter {
  readonly id = 'slack' as const;
  readonly label = 'Slack';
  private ws?: WebSocket;
  private botUserId = '';

  private get cfg() {
    return this.rt.config.platforms.slack;
  }

  protected async connect(): Promise<void> {
    if (!this.cfg.botToken || !this.cfg.appToken) throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required');
    const auth = (await (await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${this.cfg.botToken}` } })).json()) as {
      ok: boolean;
      user_id?: string;
      user?: string;
      error?: string;
    };
    if (!auth.ok) throw new Error(`Slack auth failed: ${auth.error}`);
    this.botUserId = auth.user_id ?? '';
    this.botName = auth.user;
    await this.open();
  }

  private async open(): Promise<void> {
    const r = (await (await fetch('https://slack.com/api/apps.connections.open', { method: 'POST', headers: { authorization: `Bearer ${this.cfg.appToken}` } })).json()) as {
      ok: boolean;
      url?: string;
      error?: string;
    };
    if (!r.ok || !r.url) throw new Error(`Slack socket mode: ${r.error}`);
    const ws = new WebSocket(r.url);
    this.ws = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; envelope_id?: string; payload?: { event?: SlackEvent } };
      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      if (msg.type === 'hello') this.state = 'running';
      if (msg.type === 'disconnect') ws.close();
      if (msg.type === 'events_api' && msg.payload?.event) void this.handle(msg.payload.event);
    });
    ws.on('close', async () => {
      if (this.stopped) return;
      this.state = 'starting';
      await sleepMs(2000);
      if (!this.stopped) this.open().catch((e) => {
        this.state = 'error';
        this.detail = (e as Error).message;
      });
    });
  }

  private async handle(e: SlackEvent): Promise<void> {
    if (e.bot_id || e.subtype || !e.user || e.user === this.botUserId) return;
    if (e.type !== 'message' && e.type !== 'app_mention') return;
    const isDm = e.channel_type === 'im';
    const mentioned = (e.text ?? '').includes(`<@${this.botUserId}>`);
    if (!isDm && e.type === 'message' && !mentioned && !e.thread_ts) return;
    if (!isDm && e.type === 'message' && mentioned) return; // handled by app_mention
    const text = (e.text ?? '').replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
    const images = [];
    for (const f of e.files ?? []) {
      if (f.mimetype.startsWith('image/')) images.push({ type: 'image' as const, mediaType: f.mimetype, data: (await downloadBuffer(f.url_private, { authorization: `Bearer ${this.cfg.botToken}` })).toString('base64') });
    }
    const thread = isDm ? '' : (e.thread_ts ?? e.ts);
    this.deliver({
      platform: 'slack',
      chatId: thread ? `${e.channel}:${thread}` : e.channel,
      userId: e.user,
      text,
      images: images.length ? images : undefined,
      isGroup: !isDm,
    });
  }

  protected async disconnect(): Promise<void> {
    this.ws?.close();
  }

  async send(target: string, text: string): Promise<void> {
    await sendPlatformMessage('slack', target, text, this.rt.config.platforms);
  }
}
