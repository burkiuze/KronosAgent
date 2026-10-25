import { KeyRound, Sparkles } from 'lucide-react';
import { answerHeld, setState, useStore } from '../lib/store';
import { t } from '../lib/i18n';

/**
 * Kronos never answers with the offline demo model by itself. Without a sessionId this is the
 * welcome-screen prompt to connect a provider; with one it sits under a message that arrived before
 * any provider was connected, links to the provider settings, and once connected offers to answer.
 */
export function ConnectCard({ sessionId }: { sessionId?: string }) {
  const needsProvider = useStore((s) => Boolean(s.status?.needsProvider));
  const held = Boolean(sessionId);
  const ready = held && !needsProvider;
  const title = !held ? t('connect.title') : ready ? t('connect.readyTitle') : t('connect.heldTitle');
  const body = !held ? t('connect.body') : ready ? t('connect.readyBody') : t('connect.heldBody');
  return (
    <div className={`connect-card ${held ? 'attention' : ''}`} role={held && !ready ? 'alert' : undefined}>
      <span className="connect-icon">{ready ? <Sparkles size={16} /> : <KeyRound size={16} />}</span>
      <div className="connect-text">
        <b>{title}</b>
        <span>{body}</span>
      </div>
      {ready ? (
        <button className="btn primary connect-btn" onClick={() => void answerHeld(sessionId as string)}>
          {t('connect.answer')}
        </button>
      ) : (
        <button className="btn primary connect-btn" onClick={() => setState({ settings: 'keys' })}>
          {t('connect.button')}
        </button>
      )}
    </div>
  );
}
