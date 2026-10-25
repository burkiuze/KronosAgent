import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, KeyRound, Star } from 'lucide-react';
import { get } from '../lib/api';
import { getState, setSessionModel, setState, toast, useStore } from '../lib/store';
import { updateConfig } from '../lib/config';
import type { ModelInfo } from '../lib/types';
import { tokens } from '../lib/format';
import { ProviderLogo } from './ProviderConnect';
import { fitPopover } from './ui';

interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  local: boolean;
}

/** `compact` right-aligns the popup; `down` opens it below the trigger (the centered welcome composer). */
export function ModelPicker({ children, compact, down }: { children: ReactNode; compact?: boolean; down?: boolean }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [q, setQ] = useState('');
  const [custom, setCustom] = useState('');
  const currentId = useStore((s) => s.currentId);
  const sessions = useStore((s) => s.sessions);
  const status = useStore((s) => s.status);
  const draft = useStore((s) => s.draftModel);
  const current = sessions.find((s) => s.id === currentId)?.model || draft || status?.model?.ref;

  useEffect(() => {
    if (!open) return;
    void Promise.all([get<{ models: ModelInfo[] }>('/api/models'), get<ProviderStatus[]>('/api/providers')]).then(([m, p]) => {
      setModels(m.models);
      setProviders(p);
    });
  }, [open]);

  const groups = useMemo(() => {
    const ql = q.toLowerCase();
    const map = new Map<string, ModelInfo[]>();
    for (const m of models) {
      if (ql && !`${m.name} ${m.ref}`.toLowerCase().includes(ql)) continue;
      map.set(m.provider, [...(map.get(m.provider) ?? []), m]);
    }
    return [...map.entries()];
  }, [models, q]);

  const choose = async (ref: string) => {
    setOpen(false);
    const id = getState().currentId;
    if (id) {
      await setSessionModel(id, ref);
      toast(`Model → ${ref}`);
    } else setState({ draftModel: ref });
  };

  const unconfigured = providers.filter((p) => !p.configured && !p.local);
  const pop = useRef<HTMLDivElement>(null);
  // re-fit once the model list has loaded, since that is what makes the popup tall
  useLayoutEffect(() => {
    if (open && pop.current) fitPopover(pop.current);
  }, [open, models.length, providers.length]);

  return (
    <div className="menu-wrap">
      <span onClick={() => setOpen((o) => !o)} style={{ cursor: 'pointer' }}>
        {children}
      </span>
      {open && (
        <>
          <div className="click-catcher" onClick={() => setOpen(false)} />
          <div ref={pop} className={`model-picker ${compact ? 'up' : ''} ${down ? 'down' : ''}`}>
            <input className="model-search" autoFocus placeholder="Search models or type provider:model…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="model-list">
              {groups.map(([provider, list]) => (
                <div key={provider}>
                  <div className="model-group">
                    <ProviderLogo id={provider} label={providers.find((p) => p.id === provider)?.label ?? provider} size={18} />
                    {providers.find((p) => p.id === provider)?.label ?? provider}
                  </div>
                  {list.map((m) => (
                    <button key={m.ref} className={`model-row ${m.ref === current ? 'active' : ''}`} onClick={() => void choose(m.ref)}>
                      <div>
                        <div className="model-name">
                          {m.name} {m.tags?.includes('recommended') && <Star size={11} className="accent" />}
                        </div>
                        <div className="model-meta">
                          {m.ref} · {tokens(m.contextWindow)} ctx{m.pricing ? ` · $${m.pricing.input}/$${m.pricing.output}` : ''}
                        </div>
                      </div>
                      {m.ref === current && <Check size={14} />}
                    </button>
                  ))}
                </div>
              ))}
              {!groups.length && <div className="muted pad">No models match.</div>}
            </div>
            <div className="model-foot">
              <input placeholder="custom: openrouter:vendor/model" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && custom && void choose(custom)} />
              <button
                className="btn small"
                disabled={!current}
                onClick={() => {
                  if (current) void updateConfig({ model: { default: current } });
                  setOpen(false);
                }}
              >
                Set as default
              </button>
            </div>
            {unconfigured.length > 0 && (
              <button className="model-keys" onClick={() => (setOpen(false), setState({ settings: 'keys' }))}>
                <KeyRound size={13} /> Add keys for {unconfigured.slice(0, 4).map((p) => p.label).join(', ')}…
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
