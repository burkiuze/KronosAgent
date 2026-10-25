import { sendPlatformMessage, newId } from '@kronos/core';
import { PlatformAdapter, sleepMs } from './base.js';

/** Matrix via the client-server /sync long poll (auto-joins invites). */
export class MatrixAdapter extends PlatformAdapter {
  readonly id = 'matrix' as const;
  readonly label = 'Matrix';
  private since?: string;
  private abort?: AbortController;

  private get cfg() {
    return this.rt.config.platforms.matrix;
  }
  private get hs(): string {
    return (this.cfg.homeserver ?? '').replace(/\/$/, '');
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.hs}/_matrix/client/v3${path}`, { ...init, headers: { authorization: `Bearer ${this.cfg.accessToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`Matrix ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  protected async connect(): Promise<void> {
    if (!this.hs || !this.cfg.accessToken) throw new Error('matrix homeserver and access token are required');
    const who = await this.api<{ user_id: string }>('/account/whoami');
    this.botName = who.user_id;
    const first = await this.api<{ next_batch: string }>('/sync?timeout=0&filter={"room":{"timeline":{"limit":0}}}');
    this.since = first.next_batch;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const res = await this.api<{
          next_batch: string;
          rooms?: { join?: Record<string, { timeline?: { events?: { type: string; sender: string; content?: { msgtype?: string; body?: string } }[] } }>; invite?: Record<string, unknown> };
        }>(`/sync?timeout=30000&since=${encodeURIComponent(this.since ?? '')}`, { signal: this.abort.signal });
        this.since = res.next_batch;
        this.state = 'running';
        for (const roomId of Object.keys(res.rooms?.invite ?? {})) await this.api(`/join/${encodeURIComponent(roomId)}`, { method: 'POST', body: '{}' }).catch(() => undefined);
        for (const [roomId, room] of Object.entries(res.rooms?.join ?? {})) {
          for (const ev of room.timeline?.events ?? []) {
            if (ev.type !== 'm.room.message' || ev.sender === this.botName || ev.content?.msgtype !== 'm.text') continue;
            this.deliver({ platform: 'matrix', chatId: roomId, userId: ev.sender, text: ev.content.body ?? '' });
          }
        }
      } catch (e) {
        if (this.stopped) break;
        this.state = 'error';
        this.detail = (e as Error).message;
        await sleepMs(5000);
      }
    }
  }

  protected async disconnect(): Promise<void> {
    this.abort?.abort();
  }

  async send(target: string, text: string): Promise<void> {
    await sendPlatformMessage('matrix', target, text, this.rt.config.platforms);
  }

  override async typing(target: string): Promise<void> {
    await this.api(`/rooms/${encodeURIComponent(target)}/typing/${encodeURIComponent(this.botName ?? '')}`, { method: 'PUT', body: JSON.stringify({ typing: true, timeout: 20000 }) }).catch(() => undefined);
  }
}

/** Signal via signal-cli-rest-api (polling /v1/receive). */
export class SignalAdapter extends PlatformAdapter {
  readonly id = 'signal' as const;
  readonly label = 'Signal';

  private get cfg() {
    return this.rt.config.platforms.signal;
  }

  protected async connect(): Promise<void> {
    if (!this.cfg.apiUrl || !this.cfg.number) throw new Error('signal apiUrl and number are required');
    this.botName = this.cfg.number;
    void this.loop();
  }

  private async loop(): Promise<void> {
    const api = (this.cfg.apiUrl ?? '').replace(/\/$/, '');
    while (!this.stopped) {
      try {
        const res = await fetch(`${api}/v1/receive/${encodeURIComponent(this.cfg.number ?? '')}`);
        if (!res.ok) throw new Error(`receive ${res.status}`);
        const items = (await res.json()) as { envelope?: { source?: string; sourceNumber?: string; sourceName?: string; dataMessage?: { message?: string; groupInfo?: { groupId: string } } } }[];
        this.state = 'running';
        for (const it of items) {
          const env = it.envelope;
          const text = env?.dataMessage?.message;
          if (!env || !text) continue;
          const from = env.sourceNumber ?? env.source ?? '';
          const group = env.dataMessage?.groupInfo?.groupId;
          this.deliver({ platform: 'signal', chatId: group ? `group.${group}` : from, userId: from, userName: env.sourceName, text, isGroup: Boolean(group) });
        }
      } catch (e) {
        this.state = 'error';
        this.detail = (e as Error).message;
        await sleepMs(5000);
      }
      await sleepMs(2000);
    }
  }

  protected async disconnect(): Promise<void> {}

  async send(target: string, text: string): Promise<void> {
    await sendPlatformMessage('signal', target, text, this.rt.config.platforms);
  }
}

/** WhatsApp Cloud API — inbound messages arrive on the gateway webhook (/hooks/whatsapp). */
export class WhatsAppAdapter extends PlatformAdapter {
  readonly id = 'whatsapp' as const;
  readonly label = 'WhatsApp';

  protected async connect(): Promise<void> {
    const c = this.rt.config.platforms.whatsapp;
    if (!c.accessToken || !c.phoneNumberId) throw new Error('WhatsApp access token and phone number id are required');
    this.botName = c.phoneNumberId;
    this.detail = 'Webhook: <public url>/hooks/whatsapp';
  }

  protected async disconnect(): Promise<void> {}

  /** Called by the gateway webhook route. */
  receive(body: unknown): void {
    const entries = (body as { entry?: { changes?: { value?: { messages?: { from: string; type: string; text?: { body: string } }[]; contacts?: { profile?: { name?: string } }[] } }[] }[] }).entry ?? [];
    for (const e of entries) {
      for (const ch of e.changes ?? []) {
        for (const m of ch.value?.messages ?? []) {
          if (m.type !== 'text' || !m.text?.body) continue;
          this.deliver({ platform: 'whatsapp', chatId: m.from, userId: m.from, userName: ch.value?.contacts?.[0]?.profile?.name, text: m.text.body });
        }
      }
    }
  }

  async send(target: string, text: string): Promise<void> {
    await sendPlatformMessage('whatsapp', target, text, this.rt.config.platforms);
  }
}

/** Generic webhook: POST /hooks/webhook {text, user?, chat?} → {text}. Great for Shortcuts, n8n, Zapier. */
export class WebhookAdapter extends PlatformAdapter {
  readonly id = 'webhook' as const;
  readonly label = 'Webhook';
  protected async connect(): Promise<void> {
    this.detail = 'POST <gateway>/hooks/webhook';
  }
  protected async disconnect(): Promise<void> {}
  async send(target: string, text: string): Promise<void> {
    if (/^https?:\/\//.test(target)) await sendPlatformMessage('webhook', target, text, this.rt.config.platforms);
  }
  newChatId(): string {
    return newId('wh_');
  }
}
