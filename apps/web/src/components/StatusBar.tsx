import { useEffect, useState } from 'react';
import { Command, Cpu, Loader, Bot, Clock, Radio, Coins } from 'lucide-react';
import { chatOf, setState, useStore } from '../lib/store';
import { clock, cost, tokens } from '../lib/format';
import { t } from '../lib/i18n';
import { ModelPicker } from './ModelPicker';

export function StatusBar() {
  const connected = useStore((s) => s.connected);
  const running = useStore((s) => s.running);
  const status = useStore((s) => s.status);
  const currentId = useStore((s) => s.currentId);
  const chat = useStore((s) => chatOf(s.currentId));
  const sessions = useStore((s) => s.sessions);
  const session = sessions.find((x) => x.id === currentId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const usage = chat.usage ?? session?.usage;
  const totalTokens = usage ? usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0;
  const sessionStart = session?.createdAt;
  return (
    <footer className="statusbar">
      <button className="sb-item" title="Command palette (⌘K)" onClick={() => setState({ paletteOpen: true })}>
        <Command size={12} />
      </button>
      <span className={`sb-item ${connected ? '' : 'warn'}`} title={status?.gateway?.url}>
        <Radio size={12} /> {t('status.gateway')} <span className="sb-dim">{connected ? t('status.ready') : t('status.offline')}</span>
      </span>
      <span className="sb-item" title={running.map((r) => r.title || r.sessionId).join('\n')}>
        {running.length ? <Loader size={12} className="spin" /> : <Bot size={12} />} {t('nav.agents')}
        {running.length > 0 && <span className="sb-dim">{running.length} {t('status.running')}</span>}
      </span>
      <button className="sb-item" onClick={() => setState({ view: 'automations' })}>
        <Clock size={12} /> {t('status.cron')} {status?.cron?.jobs ? <span className="sb-dim">{status.cron.jobs}</span> : null}
      </button>
      <div className="flex-1" />
      {chat.running && chat.runStartedAt && (
        <span className="sb-item">
          <Loader size={12} className="spin" /> Running <span className="sb-dim">{clock(now - chat.runStartedAt)}</span>
        </span>
      )}
      {chat.context && (
        <span className="sb-item" title={`${tokens(chat.context.tokens)} / ${tokens(chat.context.window)} context`}>
          <span className="ctx-meter">
            <span style={{ width: `${Math.min(100, chat.context.percent)}%` }} />
          </span>
          {chat.context.percent}%
        </span>
      )}
      {totalTokens > 0 && (
        <span className="sb-item" title={usage ? `in ${tokens(usage.inputTokens)} · cached ${tokens(usage.cacheReadTokens)} · out ${tokens(usage.outputTokens)}` : ''}>
          {tokens(totalTokens)} tok
        </span>
      )}
      {!!usage?.costUsd && (
        <span className="sb-item">
          <Coins size={12} /> {cost(usage.costUsd)}
        </span>
      )}
      {sessionStart && (
        <span className="sb-item">
          {t('status.session')} <span className="sb-dim">{clock(now - sessionStart)}</span>
        </span>
      )}
      <ModelPicker compact>
        <span className="sb-item model">
          <Cpu size={12} /> {modelLabel(session?.model, status?.model?.name)}
          <span className="sb-dim">{providerOf(session?.model ?? status?.model?.ref)}</span>
        </span>
      </ModelPicker>
    </footer>
  );
}

function modelLabel(ref: string | undefined, fallback?: string): string {
  if (!ref) return fallback ?? 'Kronos';
  const id = ref.split(':').slice(1).join(':') || ref;
  return id;
}

function providerOf(ref?: string): string {
  return ref?.split(':')[0] ?? '';
}
