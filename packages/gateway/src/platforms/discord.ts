import WebSocket from 'ws';
import { sendPlatformMessage } from '@kronos/core';
import { PlatformAdapter, downloadBuffer, sleepMs } from './base.js';

const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15); // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  mentions?: { id: string }[];
  attachments?: { url: string; content_type?: string; filename: string }[];
}

/** Discord bot over the Gateway WebSocket (no public URL needed). */
export class DiscordAdapter extends PlatformAdapter {
  readonly id = 'discord' as const;
  readonly label = 'Discord';
  private ws?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private seq: number | null = null;
  private botId = '';

  private get token(): string {
    return this.rt.config.platforms.discord.token ?? '';
  }

  protected async connect(): Promise<void> {
    if (!this.token) throw new Error('DISCORD_BOT_TOKEN missing');
    await this.open();
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
      this.ws = ws;
      let settled = false;
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { op: number; t?: string; s?: number; d?: Record<string, unknown> };
        if (msg.s) this.seq = msg.s;
        switch (msg.op) {
          case 10: {
            const interval = Number((msg.d as { heartbeat_interval: number }).heartbeat_interval);
            clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: this.seq })), interval);
            ws.send(JSON.stringify({ op: 2, d: { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: 'kronos', device: 'kronos' } } }));
            break;
          }
          case 0:
            if (msg.t === 'READY') {
              const user = (msg.d as { user: { id: string; username: string } }).user;
              this.botId = user.id;
              this.botName = user.username;
              this.state = 'running';
              if (!settled) {
                settled = true;
                resolve();
              }
            } else if (msg.t === 'MESSAGE_CREATE') void this.handle(msg.d as unknown as DiscordMessage);
            break;
          case 7:
          case 9:
            ws.close();
            break;
        }
      });
      ws.on('close', async (code) => {
        clearInterval(this.heartbeat);
        if (!settled) {
          settled = true;
          reject(new Error(`Discord gateway closed (${code})${code === 4004 ? ': invalid token' : code === 4014 ? ': enable the Message Content intent' : ''}`));
          return;
        }
        if (this.stopped) return;
        this.state = 'starting';
        await sleepMs(3000);
        if (!this.stopped) this.open().catch((e) => {
          this.state = 'error';
          this.detail = (e as Error).message;
        });
      });
      ws.on('error', (e) => {
        this.detail = e.message;
      });
    });
  }

  private async handle(m: DiscordMessage): Promise<void> {
    if (m.author.bot) return;
    const isGroup = Boolean(m.guild_id);
    const cfg = this.rt.config.platforms.discord;
    const mentioned = m.mentions?.some((u) => u.id === this.botId) || m.content.includes(`<@${this.botId}>`);
    if (isGroup) {
      if (cfg.channels?.length && !cfg.channels.includes(m.channel_id)) return;
      if (cfg.mentionOnly !== false && !mentioned) return;
    }
    const text = m.content.replace(new RegExp(`<@!?${this.botId}>`, 'g'), '').trim();
    const images = [];
    for (const a of m.attachments ?? []) {
      if (a.content_type?.startsWith('image/')) images.push({ type: 'image' as const, mediaType: a.content_type, data: (await downloadBuffer(a.url)).toString('base64') });
    }
    const audioAtt = (m.attachments ?? []).find((a) => a.content_type?.startsWith('audio/'));
    const audio = audioAtt ? { data: await downloadBuffer(audioAtt.url), mediaType: audioAtt.content_type ?? 'audio/ogg' } : undefined;
    this.deliver({ platform: 'discord', chatId: m.channel_id, userId: m.author.id, userName: m.author.username, text, images: images.length ? images : undefined, audio, isGroup });
  }

  protected async disconnect(): Promise<void> {
    clearInterval(this.heartbeat);
    this.ws?.close();
  }

  async send(target: string, text: string): Promise<void> {
    await sendPlatformMessage('discord', target, text, this.rt.config.platforms);
  }

  override async typing(target: string): Promise<void> {
    await fetch(`https://discord.com/api/v10/channels/${target}/typing`, { method: 'POST', headers: { authorization: `Bot ${this.token}` } }).catch(() => undefined);
  }
}
