import type { KronosConfig } from '../config/schema.js';
import { newId } from '../util/misc.js';

export type PlatformId = 'telegram' | 'discord' | 'slack' | 'matrix' | 'whatsapp' | 'signal' | 'email' | 'webhook' | 'homeassistant';

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  matrix: 'Matrix',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  email: 'Email',
  webhook: 'Webhook',
  homeassistant: 'Home Assistant',
};

/** Split long text into platform-sized chunks on paragraph/line boundaries. */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

async function check(res: Response, label: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} send failed (${res.status}): ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Convert common Markdown to Telegram-safe HTML. */
export function markdownToTelegramHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks: string[] = [];
  let text = md.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang: string | undefined, code: string) => {
    blocks.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  text = esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<i>$2</i>')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)] ?? '');
}

/** Stateless outbound senders (used by cron delivery, the send_message tool and platform adapters). */
export async function sendPlatformMessage(platform: PlatformId, target: string, text: string, cfg: KronosConfig['platforms']): Promise<void> {
  switch (platform) {
    case 'telegram': {
      const token = cfg.telegram.token;
      if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
      for (const part of chunkText(text, 3800)) {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: target, text: markdownToTelegramHtml(part), parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
        });
        if (!res.ok) {
          // retry as plain text if the HTML conversion upset the parser
          await check(await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: target, text: part }) }), 'Telegram');
        }
      }
      return;
    }
    case 'discord': {
      if (/^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(target)) {
        for (const part of chunkText(text, 1900)) await check(await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: part }) }), 'Discord webhook');
        return;
      }
      const token = cfg.discord.token;
      if (!token) throw new Error('DISCORD_BOT_TOKEN is not configured');
      for (const part of chunkText(text, 1900)) {
        await check(
          await fetch(`https://discord.com/api/v10/channels/${target}/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bot ${token}` },
            body: JSON.stringify({ content: part, allowed_mentions: { parse: [] } }),
          }),
          'Discord',
        );
      }
      return;
    }
    case 'slack': {
      const token = cfg.slack.botToken;
      if (!token) throw new Error('SLACK_BOT_TOKEN is not configured');
      const [channel, thread] = target.split(':');
      for (const part of chunkText(text, 3800)) {
        const j = (await check(
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
            body: JSON.stringify({ channel, text: part, thread_ts: thread || undefined, mrkdwn: true }),
          }),
          'Slack',
        )) as { ok?: boolean; error?: string };
        if (j && j.ok === false) throw new Error(`Slack: ${j.error}`);
      }
      return;
    }
    case 'matrix': {
      const hs = cfg.matrix.homeserver?.replace(/\/$/, '');
      if (!hs || !cfg.matrix.accessToken) throw new Error('Matrix homeserver/access token not configured');
      for (const part of chunkText(text, 15000)) {
        await check(
          await fetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(target)}/send/m.room.message/${newId('k')}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.matrix.accessToken}` },
            body: JSON.stringify({ msgtype: 'm.text', body: part }),
          }),
          'Matrix',
        );
      }
      return;
    }
    case 'whatsapp': {
      if (!cfg.whatsapp.accessToken || !cfg.whatsapp.phoneNumberId) throw new Error('WhatsApp Cloud API not configured');
      for (const part of chunkText(text, 4000)) {
        await check(
          await fetch(`https://graph.facebook.com/v21.0/${cfg.whatsapp.phoneNumberId}/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.whatsapp.accessToken}` },
            body: JSON.stringify({ messaging_product: 'whatsapp', to: target, type: 'text', text: { body: part } }),
          }),
          'WhatsApp',
        );
      }
      return;
    }
    case 'signal': {
      const api = cfg.signal.apiUrl?.replace(/\/$/, '');
      if (!api || !cfg.signal.number) throw new Error('Signal REST API not configured');
      for (const part of chunkText(text, 4000)) {
        await check(
          await fetch(`${api}/v2/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: part, number: cfg.signal.number, recipients: [target] }) }),
          'Signal',
        );
      }
      return;
    }
    case 'webhook': {
      await check(await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, source: 'kronos' }) }), 'Webhook');
      return;
    }
    case 'homeassistant': {
      const url = cfg.homeassistant.url?.replace(/\/$/, '');
      if (!url || !cfg.homeassistant.token) throw new Error('Home Assistant not configured');
      const service = target || 'persistent_notification.create';
      const [domain, name] = service.split('.');
      await check(
        await fetch(`${url}/api/services/${domain}/${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.homeassistant.token}` },
          body: JSON.stringify({ message: text, title: 'Kronos' }),
        }),
        'Home Assistant',
      );
      return;
    }
    case 'email':
      throw new Error('Email delivery requires the gateway (SMTP); use a webhook or chat platform instead.');
    default:
      throw new Error(`unknown platform ${String(platform)}`);
  }
}

export function platformConfigured(platform: PlatformId, cfg: KronosConfig['platforms']): boolean {
  switch (platform) {
    case 'telegram':
      return Boolean(cfg.telegram.token);
    case 'discord':
      return Boolean(cfg.discord.token);
    case 'slack':
      return Boolean(cfg.slack.botToken && cfg.slack.appToken);
    case 'matrix':
      return Boolean(cfg.matrix.homeserver && cfg.matrix.accessToken);
    case 'whatsapp':
      return Boolean(cfg.whatsapp.accessToken && cfg.whatsapp.phoneNumberId);
    case 'signal':
      return Boolean(cfg.signal.apiUrl && cfg.signal.number);
    case 'webhook':
      return Boolean(cfg.webhook.enabled);
    case 'homeassistant':
      return Boolean(cfg.homeassistant.url && cfg.homeassistant.token);
    case 'email':
      return Boolean(cfg.email.smtpUrl);
    default:
      return false;
  }
}
