import { sendPlatformMessage } from '@kronos/core';
import { PlatformAdapter, downloadBuffer, sleepMs } from './base.js';

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string };
  from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
  photo?: { file_id: string; width: number }[];
  voice?: { file_id: string; mime_type?: string };
  audio?: { file_id: string; mime_type?: string };
  document?: { file_id: string; mime_type?: string; file_name?: string };
  entities?: { type: string; offset: number; length: number }[];
}

/** Telegram via Bot API long polling (no public URL needed). */
export class TelegramAdapter extends PlatformAdapter {
  readonly id = 'telegram' as const;
  readonly label = 'Telegram';
  private offset = 0;
  private abort?: AbortController;

  private get token(): string {
    return this.rt.config.platforms.telegram.token ?? '';
  }

  private async api<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const j = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
    return j.result;
  }

  protected async connect(): Promise<void> {
    if (!this.token) throw new Error('TELEGRAM_BOT_TOKEN missing');
    const me = await this.api<{ username: string }>('getMe');
    this.botName = `@${me.username}`;
    await this.api('setMyCommands', {
      commands: [
        { command: 'new', description: 'Start a fresh conversation' },
        { command: 'stop', description: 'Stop the current task' },
        { command: 'status', description: 'Session status' },
        { command: 'model', description: 'Show or switch the model' },
        { command: 'mode', description: 'Permission mode: ask | auto-edit | yolo | plan' },
        { command: 'undo', description: 'Undo the last turn' },
        { command: 'compact', description: 'Compress the conversation' },
        { command: 'sethome', description: 'Use this chat for automations' },
        { command: 'help', description: 'Help' },
      ],
    }).catch(() => undefined);
    void this.poll();
  }

  private async poll(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const updates = await this.api<TgUpdate[]>('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message'] }, this.abort.signal);
        this.state = 'running';
        this.detail = undefined;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message) void this.handle(u.message);
        }
      } catch (e) {
        if (this.stopped) break;
        this.state = 'error';
        this.detail = (e as Error).message;
        await sleepMs(5000);
      }
    }
  }

  private async file(fileId: string): Promise<Buffer> {
    const f = await this.api<{ file_path: string }>('getFile', { file_id: fileId });
    return downloadBuffer(`https://api.telegram.org/file/bot${this.token}/${f.file_path}`);
  }

  private async handle(m: TgMessage): Promise<void> {
    if (m.from?.is_bot) return;
    let text = m.text ?? m.caption ?? '';
    const isGroup = m.chat.type !== 'private';
    if (isGroup) {
      const mentioned = this.botName && text.includes(this.botName);
      if (!mentioned && !text.startsWith('/')) return;
      text = text.replace(this.botName ?? '', '').trim();
    }
    text = text.replace(/^\/(\w+)@\w+/, '/$1');
    const images = [];
    if (m.photo?.length) {
      const best = m.photo[m.photo.length - 1] as { file_id: string };
      images.push({ type: 'image' as const, mediaType: 'image/jpeg', data: (await this.file(best.file_id)).toString('base64') });
    }
    if (m.document?.mime_type?.startsWith('image/')) {
      images.push({ type: 'image' as const, mediaType: m.document.mime_type, data: (await this.file(m.document.file_id)).toString('base64') });
    }
    let audio;
    const voice = m.voice ?? m.audio;
    if (voice) audio = { data: await this.file(voice.file_id), mediaType: voice.mime_type ?? 'audio/ogg' };
    this.deliver({
      platform: 'telegram',
      chatId: String(m.chat.id),
      userId: String(m.from?.id ?? m.chat.id),
      userName: m.from?.username ?? m.from?.first_name,
      text,
      images: images.length ? images : undefined,
      audio,
      isGroup,
    });
  }

  protected async disconnect(): Promise<void> {
    this.abort?.abort();
  }

  async send(target: string, text: string): Promise<void> {
    await sendPlatformMessage('telegram', target, text, this.rt.config.platforms);
  }

  override async typing(target: string): Promise<void> {
    await this.api('sendChatAction', { chat_id: target, action: 'typing' }).catch(() => undefined);
  }
}
