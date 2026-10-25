import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { setState, useStore } from '../lib/store';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'ok' ? <CircleCheck size={15} /> : t.kind === 'error' ? <CircleX size={15} /> : <Info size={15} />}
          <span>{t.text}</span>
          <button className="icon-btn tiny" onClick={() => setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
