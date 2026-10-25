import { useEffect, useState } from 'react';
import { Check, Copy, MessageSquare, Plug, Send, ShieldCheck, X } from 'lucide-react';
import { get, post, put } from '../lib/api';
import { toast, useStore } from '../lib/store';
import { updateConfig, useConfig } from '../lib/config';
import type { PlatformStatus } from '../lib/types';
import { Badge, Field, Toggle } from '../components/ui';

interface PairingRequest {
  code: string;
  platform: string;
  userId: string;
  userName?: string;
  createdAt: number;
}

interface FieldDef {
  key: string;
  label: string;
  secretEnv?: string;
  placeholder?: string;
  list?: boolean;
  bool?: boolean;
}

const PLATFORMS: Record<string, { help: string; fields: FieldDef[]; color: string }> = {
  telegram: {
    color: '#2aabee',
    help: 'Create a bot with @BotFather, paste its token, then message it. Works behind NAT (long polling).',
    fields: [
      { key: 'token', label: 'Bot token', secretEnv: 'TELEGRAM_BOT_TOKEN', placeholder: '123456:ABC…' },
      { key: 'allowedUsers', label: 'Allowed user ids', list: true, placeholder: '12345678, @username' },
      { key: 'homeChat', label: 'Home chat (automations)', placeholder: 'chat id — or send /sethome' },
    ],
  },
  discord: {
    color: '#5865f2',
    help: 'Create an application + bot at discord.com/developers, enable the Message Content intent and invite it to your server.',
    fields: [
      { key: 'token', label: 'Bot token', secretEnv: 'DISCORD_BOT_TOKEN' },
      { key: 'allowedUsers', label: 'Allowed user ids', list: true },
      { key: 'channels', label: 'Channels (empty = all)', list: true },
      { key: 'mentionOnly', label: 'Only reply when mentioned in servers', bool: true },
      { key: 'homeChat', label: 'Home channel id' },
    ],
  },
  slack: {
    color: '#4a154b',
    help: 'Create a Slack app with Socket Mode, add the app_mentions:read, chat:write, im:history scopes and install it.',
    fields: [
      { key: 'botToken', label: 'Bot token (xoxb-)', secretEnv: 'SLACK_BOT_TOKEN' },
      { key: 'appToken', label: 'App token (xapp-)', secretEnv: 'SLACK_APP_TOKEN' },
      { key: 'allowedUsers', label: 'Allowed user ids', list: true },
      { key: 'homeChat', label: 'Home channel id' },
    ],
  },
  matrix: {
    color: '#0dbd8b',
    help: 'Use a dedicated Matrix account. Invites are accepted automatically.',
    fields: [
      { key: 'homeserver', label: 'Homeserver URL', placeholder: 'https://matrix.org' },
      { key: 'userId', label: 'Bot user id', placeholder: '@kronos:matrix.org' },
      { key: 'accessToken', label: 'Access token', secretEnv: 'MATRIX_ACCESS_TOKEN' },
      { key: 'allowedUsers', label: 'Allowed users', list: true },
    ],
  },
  whatsapp: {
    color: '#25d366',
    help: 'WhatsApp Cloud API: point the webhook to <public gateway url>/hooks/whatsapp with your verify token.',
    fields: [
      { key: 'accessToken', label: 'Access token', secretEnv: 'WHATSAPP_ACCESS_TOKEN' },
      { key: 'phoneNumberId', label: 'Phone number id' },
      { key: 'verifyToken', label: 'Webhook verify token', secretEnv: 'WHATSAPP_VERIFY_TOKEN' },
      { key: 'allowedUsers', label: 'Allowed phone numbers', list: true },
    ],
  },
  signal: {
    color: '#3a76f0',
    help: 'Run signal-cli-rest-api (Docker) and register a number.',
    fields: [
      { key: 'apiUrl', label: 'signal-cli REST URL', placeholder: 'http://127.0.0.1:8080' },
      { key: 'number', label: 'Bot number', placeholder: '+15551234567' },
      { key: 'allowedUsers', label: 'Allowed numbers', list: true },
    ],
  },
  webhook: {
    color: '#888888',
    help: 'POST {"text": "…", "chat": "optional"} to <gateway>/hooks/webhook with header X-Kronos-Secret. Great for iOS Shortcuts, n8n, Zapier.',
    fields: [{ key: 'secret', label: 'Shared secret', secretEnv: 'KRONOS_WEBHOOK_SECRET' }],
  },
  homeassistant: {
    color: '#18bcf2',
    help: 'Send notifications to Home Assistant (send_message to "homeassistant:notify.mobile_app_phone").',
    fields: [
      { key: 'url', label: 'Home Assistant URL', placeholder: 'http://homeassistant.local:8123' },
      { key: 'token', label: 'Long-lived token', secretEnv: 'HASS_TOKEN' },
    ],
  },
};

function SecretInput({ env, placeholder }: { env: string; placeholder?: string }) {
  const [value, setValue] = useState('');
  const [set, setSet] = useState<boolean | null>(null);
  useEffect(() => {
    void get<{ keys: { name: string; set: boolean }[] }>('/api/keys').then((r) => setSet(r.keys.find((k) => k.name === env)?.set ?? false));
  }, [env]);
  return (
    <div className="secret-input">
      <input type="password" value={value} placeholder={set ? '•••••••• (saved)' : (placeholder ?? env)} onChange={(e) => setValue(e.target.value)} />
      <button
        className="btn small"
        disabled={!value}
        onClick={async () => {
          await put('/api/keys', { name: env, value });
          setValue('');
          setSet(true);
          toast(`${env} saved`);
        }}
      >
        Save
      </button>
    </div>
  );
}

function PlatformCard({ status, onChange }: { status: PlatformStatus; onChange: () => void }) {
  const { config } = useConfig();
  const def = PLATFORMS[status.id];
  const pc = config?.platforms?.[status.id] ?? {};
  const [open, setOpen] = useState(false);
  const [testTarget, setTestTarget] = useState('');
  if (!def) return null;
  const tone = status.state === 'running' ? 'ok' : status.state === 'error' ? 'error' : status.state === 'starting' ? 'warn' : 'neutral';
  return (
    <div className={`platform-card ${open ? 'open' : ''}`}>
      <div className="platform-head" onClick={() => setOpen((o) => !o)}>
        <span className="platform-dot" style={{ background: def.color }} />
        <div className="list-main">
          <div className="list-title">
            {status.label} {status.botName && <span className="muted">· {status.botName}</span>}
          </div>
          <div className="list-desc">{status.detail ?? def.help}</div>
        </div>
        <Badge tone={tone}>{status.state}</Badge>
        {status.messages > 0 && <Badge>{status.messages} msgs</Badge>}
        <Toggle
          checked={status.enabled}
          onChange={async (v) => {
            try {
              await post(`/api/platforms/${status.id}/${v ? 'start' : 'stop'}`);
              toast(`${status.label} ${v ? 'started' : 'stopped'}`);
            } catch (e) {
              toast(`${status.label}: ${(e as Error).message}`, 'error');
            }
            onChange();
          }}
        />
      </div>
      {open && (
        <div className="platform-body">
          <p className="muted small">{def.help}</p>
          {def.fields.map((f) => (
            <Field key={f.key} label={f.label}>
              {f.secretEnv ? (
                <SecretInput env={f.secretEnv} placeholder={f.placeholder} />
              ) : f.bool ? (
                <Toggle checked={pc[f.key] !== false} onChange={(v) => void updateConfig({ platforms: { [status.id]: { [f.key]: v } } })} />
              ) : (
                <input
                  defaultValue={f.list ? (pc[f.key] ?? []).join(', ') : (pc[f.key] ?? '')}
                  placeholder={f.placeholder}
                  onBlur={(e) => {
                    const v = f.list ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : e.target.value.trim();
                    void updateConfig({ platforms: { [status.id]: { [f.key]: v } } });
                  }}
                />
              )}
            </Field>
          ))}
          <Field label="Permission mode for chats from this platform">
            <select defaultValue={pc.mode ?? 'auto-edit'} onChange={(e) => void updateConfig({ platforms: { [status.id]: { mode: e.target.value } } })}>
              <option value="ask">ask — approve in chat</option>
              <option value="auto-edit">auto-edit</option>
              <option value="yolo">yolo</option>
              <option value="plan">plan (read-only)</option>
            </select>
          </Field>
          <div className="test-row">
            <input placeholder="Test target (chat id) — empty = home chat" value={testTarget} onChange={(e) => setTestTarget(e.target.value)} />
            <button
              className="btn small"
              onClick={async () => {
                try {
                  await post(`/api/platforms/${status.id}/test`, { target: testTarget || 'home' });
                  toast('Test message sent');
                } catch (e) {
                  toast((e as Error).message, 'error');
                }
              }}
            >
              <Send size={12} /> Test
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="copy-line">
      <span className="muted">{label}</span>
      <code>{value}</code>
      <button
        className="icon-btn tiny"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        }}
      >
        {ok ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

export function MessagingPage() {
  const [platforms, setPlatforms] = useState<PlatformStatus[]>([]);
  const [pairing, setPairing] = useState<PairingRequest[]>([]);
  const status = useStore((s) => s.status);
  const load = () =>
    void get<{ platforms: PlatformStatus[]; pairing: PairingRequest[] }>('/api/platforms').then((r) => {
      setPlatforms(r.platforms);
      setPairing(r.pairing);
    });
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);
  const origin = status?.gateway?.url ?? window.location.origin;
  return (
    <div className="page">
      <div className="page-head">
        <MessageSquare size={18} />
        <div>
          <h2>Messaging</h2>
          <p className="muted">Talk to Kronos from anywhere. Conversations continue across platforms; automations deliver here.</p>
        </div>
      </div>
      <div className="page-body">
        {pairing.length > 0 && (
          <div className="pairing">
            <h4>
              <ShieldCheck size={14} /> Pairing requests
            </h4>
            {pairing.map((p) => (
              <div key={p.code} className="list-row">
                <div className="list-main">
                  <div className="list-title">
                    {p.userName ?? p.userId} <span className="muted">on {p.platform}</span>
                  </div>
                  <div className="list-desc">
                    code <b>{p.code}</b> · id {p.userId}
                  </div>
                </div>
                <button className="btn small primary" onClick={async () => (await post(`/api/pairing/${p.code}/approve`), toast('Paired'), load())}>
                  <Check size={12} /> Approve
                </button>
                <button className="btn small" onClick={async () => (await post(`/api/pairing/${p.code}/deny`), load())}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {platforms
          .filter((p) => PLATFORMS[p.id])
          .map((p) => (
            <PlatformCard key={p.id} status={p} onChange={load} />
          ))}
        <div className="info-card">
          <h4>
            <Plug size={14} /> Use Kronos from other apps
          </h4>
          <CopyLine label="OpenAI-compatible base URL" value={`${origin}/v1`} />
          <CopyLine label="Model name" value="kronos" />
          <CopyLine label="Webhook" value={`${origin}/hooks/webhook`} />
          <CopyLine label="MCP server (stdio)" value="kronos mcp serve" />
          <p className="muted small">Any OpenAI client (Open WebUI, LibreChat, Continue, scripts) gets the full agent — tools, memory and skills — as a model.</p>
        </div>
      </div>
    </div>
  );
}
