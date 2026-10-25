import type { ImagePart, Kronos, PlatformId } from '@kronos/core';

export interface IncomingMessage {
  platform: PlatformId;
  chatId: string;
  userId: string;
  userName?: string;
  text: string;
  images?: ImagePart[];
  audio?: { data: Buffer; mediaType: string };
  isGroup?: boolean;
  /** platform-specific reply target (e.g. Slack thread) */
  replyTarget?: string;
}

export interface PlatformStatus {
  id: PlatformId;
  label: string;
  state: 'disabled' | 'stopped' | 'starting' | 'running' | 'error';
  detail?: string;
  botName?: string;
  configured: boolean;
  enabled: boolean;
  messages: number;
}

export interface PlatformContext {
  runtime: () => Kronos;
  onMessage(msg: IncomingMessage): Promise<void>;
  log(text: string): void;
}

export abstract class PlatformAdapter {
  abstract readonly id: PlatformId;
  abstract readonly label: string;
  state: PlatformStatus['state'] = 'stopped';
  detail?: string;
  botName?: string;
  messages = 0;
  protected ctx!: PlatformContext;
  protected stopped = false;

  async start(ctx: PlatformContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    this.state = 'starting';
    try {
      await this.connect();
      if (this.state === 'starting') this.state = 'running';
    } catch (e) {
      this.state = 'error';
      this.detail = (e as Error).message;
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.disconnect();
    this.state = 'stopped';
  }

  protected abstract connect(): Promise<void>;
  protected abstract disconnect(): Promise<void>;
  abstract send(target: string, text: string): Promise<void>;
  /** show "typing…" while the agent works (optional) */
  async typing(_target: string): Promise<void> {}

  protected get rt(): Kronos {
    return this.ctx.runtime();
  }

  protected deliver(msg: IncomingMessage): void {
    this.messages += 1;
    void this.ctx.onMessage(msg).catch((e) => this.ctx.log(`${this.id}: ${(e as Error).message}`));
  }
}

export async function downloadBuffer(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
