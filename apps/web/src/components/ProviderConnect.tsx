import { useEffect, useMemo, useState } from 'react';
import { CircleCheck, CircleX, ExternalLink, LoaderCircle, Plug, Plus, Trash2, Unplug } from 'lucide-react';
import { get, post, put } from '../lib/api';
import { toast } from '../lib/store';
import { loadConfig, updateConfig, useConfig } from '../lib/config';
import { t } from '../lib/i18n';
import type { ModelInfo } from '../lib/types';
import { PROVIDER_LOGOS } from '../lib/providerLogos';

interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  local: boolean;
  baseUrl: string;
  envKeys: string[];
  docsUrl?: string;
  custom?: boolean;
}

interface KeyRow {
  name: string;
  set: boolean;
  preview: string | null;
}

interface ConnectionTest {
  ok: boolean;
  models: number;
  sample: string[];
  latencyMs: number;
  verified?: boolean;
  error?: string;
}

/** Popular first; the rest keep the catalog order. */
const ORDER = ['anthropic', 'openai', 'gemini', 'openrouter', 'deepseek', 'xai', 'mistral', 'groq', 'ollama', 'lmstudio'];

export function ProviderLogo({ id, label, size = 30 }: { id: string; label: string; size?: number }) {
  const svg = PROVIDER_LOGOS[id];
  return (
    <span className="pv-badge" style={{ width: size, height: size }} title={label}>
      {svg ? <span className="pv-logo" dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="pv-initials">{label.replace(/[^A-Za-z0-9]/g, '').slice(0, 2)}</span>}
    </span>
  );
}

function ProviderBadge({ p, size = 30 }: { p: ProviderStatus; size?: number }) {
  return <ProviderLogo id={p.id} label={p.label} size={size} />;
}

/**
 * "Connect a provider": pick a provider, paste a key (or a local URL), verify it live,
 * then choose which of its models Kronos should use by default.
 */
export function ProviderConnect({ onChanged }: { onChanged?: () => void }) {
  const { config } = useConfig();
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState('');
  const [custom, setCustom] = useState({ id: '', baseUrl: '', apiKey: '' });

  const load = async () => {
    const [p, k] = await Promise.all([get<ProviderStatus[]>('/api/providers'), get<{ keys: KeyRow[] }>('/api/keys')]);
    const list = p.filter((x) => x.id !== 'kronos');
    list.sort((a, b) => rank(a.id) - rank(b.id));
    setProviders(list);
    setKeys(k.keys);
    return list;
  };
  useEffect(() => {
    void load().then((list) => setSelected((cur) => cur ?? list.find((x) => x.configured)?.id ?? list[0]?.id ?? null));
  }, []);

  const current = providers.find((p) => p.id === selected);
  const envKey = current?.envKeys[0];
  const saved = envKey ? keys.find((k) => k.name === envKey) : undefined;
  const defaultRef = (config?.model?.default as string | undefined) ?? 'auto';

  useEffect(() => {
    setKey('');
    setResult(null);
    setModels([]);
    setModel('');
    setBaseUrl(current?.baseUrl ?? '');
  }, [selected]);

  const loadModels = async (id: string) => {
    const r = await get<{ models: ModelInfo[] }>(`/api/models?provider=${encodeURIComponent(id)}`);
    setModels(r.models);
    const preferred = r.models.find((m) => m.ref === defaultRef) ?? r.models.find((m) => (m as ModelInfo & { tags?: string[] }).tags?.includes('recommended')) ?? r.models[0];
    setModel(preferred?.ref ?? '');
  };

  const test = async (id: string) => {
    const r = await post<ConnectionTest>(`/api/providers/${encodeURIComponent(id)}/test`);
    setResult(r);
    if (r.ok) await loadModels(id);
    return r;
  };

  const connect = async () => {
    if (!current) return;
    setBusy(true);
    try {
      if (current.local || current.custom) {
        if (baseUrl && baseUrl !== current.baseUrl) {
          if (current.custom) {
            const list = (config?.customProviders as { id: string; baseUrl: string }[] | undefined) ?? [];
            await updateConfig({ customProviders: list.map((c) => (c.id === current.id ? { ...c, baseUrl } : c)) });
          } else await updateConfig({ providers: { [current.id]: { baseUrl } } });
        }
      } else if (key.trim() && envKey) {
        // verified before it is saved: a rejected key never lands in .env
        const r = await post<ConnectionTest & { saved: boolean }>(`/api/providers/${encodeURIComponent(current.id)}/connect`, { apiKey: key.trim() });
        setResult(r);
        if (r.ok) {
          setKey('');
          await loadModels(current.id);
        }
        await load();
        await loadConfig();
        onChanged?.();
        toast(r.ok ? t('pv.connectedToast', { name: current.label }) : r.error ?? t('pv.failed'), r.ok ? 'ok' : 'error');
        return;
      }
      const r = await test(current.id);
      await load();
      await loadConfig();
      onChanged?.();
      toast(r.ok ? t('pv.connectedToast', { name: current.label }) : r.error ?? t('pv.failed'), r.ok ? 'ok' : 'error');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!current || !envKey) return;
    if (!confirm(t('pv.disconnectConfirm', { name: current.label }))) return;
    await put('/api/keys', { name: envKey, value: null });
    setResult(null);
    setModels([]);
    await load();
    await loadConfig();
    onChanged?.();
  };

  const addCustom = async () => {
    const list = (config?.customProviders as unknown[] | undefined) ?? [];
    const id = custom.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!id || !custom.baseUrl.trim()) return;
    await updateConfig({ customProviders: [...list, { id, label: custom.id.trim(), baseUrl: custom.baseUrl.trim(), apiKey: custom.apiKey.trim() || undefined }] });
    setCustom({ id: '', baseUrl: '', apiKey: '' });
    await load();
    setSelected(id);
  };

  const groupedModels = useMemo(() => models.slice(0, 200), [models]);
  const needsKey = Boolean(current && !current.local && !current.custom && envKey);

  return (
    <div className="pv">
      <div className="pv-grid">
        {providers.map((p) => (
          <button key={p.id} className={`pv-tile ${selected === p.id ? 'selected' : ''}`} onClick={() => setSelected(p.id)}>
            <ProviderBadge p={p} />
            <span className="pv-name">{p.label.replace(/ \(local\)$/, '')}</span>
            {/* local servers need no key, so "configured" says nothing about whether they are running */}
            <span className={`pv-state ${p.configured && !p.local ? 'on' : ''}`}>{p.local ? t('pv.local') : p.configured ? t('pv.connected') : t('pv.notConnected')}</span>
          </button>
        ))}
        <button className={`pv-tile ${selected === '__custom' ? 'selected' : ''}`} onClick={() => setSelected('__custom')}>
          <span className="pv-badge plus">
            <Plus size={16} />
          </span>
          <span className="pv-name">{t('pv.custom')}</span>
          <span className="pv-state">OpenAI / Anthropic API</span>
        </button>
      </div>

      {selected === '__custom' && (
        <div className="pv-panel">
          <div className="pv-panel-title">{t('pv.customTitle')}</div>
          <p className="pv-help">{t('pv.customHelp')}</p>
          <div className="pv-form">
            <input placeholder={t('pv.customName')} value={custom.id} onChange={(e) => setCustom({ ...custom, id: e.target.value })} />
            <input placeholder="https://my-gateway.example.com/v1" value={custom.baseUrl} onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })} />
            <input type="password" placeholder={t('pv.keyOptional')} value={custom.apiKey} onChange={(e) => setCustom({ ...custom, apiKey: e.target.value })} />
            <button className="btn primary" disabled={!custom.id.trim() || !custom.baseUrl.trim()} onClick={() => void addCustom()}>
              <Plus size={14} /> {t('pv.add')}
            </button>
          </div>
        </div>
      )}

      {current && (
        <div className="pv-panel">
          <div className="pv-panel-head">
            <ProviderBadge p={current} size={36} />
            <div className="flex-1">
              <div className="pv-panel-title">{current.label}</div>
              <div className="pv-help">{current.local ? t('pv.localHelp') : current.custom ? current.baseUrl : saved?.set ? t('pv.keySaved', { preview: saved.preview ?? '••••' }) : t('pv.keyHelp')}</div>
            </div>
            {current.docsUrl && needsKey && (
              <a className="btn small" href={current.docsUrl} target="_blank" rel="noreferrer">
                {t('pv.getKey')} <ExternalLink size={12} />
              </a>
            )}
          </div>

          <div className="pv-form">
            {needsKey ? (
              <input
                type="password"
                autoComplete="off"
                placeholder={saved?.set ? t('pv.replaceKey') : t('pv.pasteKey', { env: envKey ?? '' })}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void connect()}
              />
            ) : (
              <input placeholder="http://127.0.0.1:11434/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void connect()} />
            )}
            <button className="btn primary" disabled={busy || (needsKey && !key.trim() && !saved?.set)} onClick={() => void connect()}>
              {busy ? <LoaderCircle size={14} className="spin" /> : <Plug size={14} />}
              {needsKey && !saved?.set ? t('pv.connect') : t('pv.test')}
            </button>
            {needsKey && saved?.set && (
              <button className="btn" onClick={() => void disconnect()} title={t('pv.disconnect')}>
                <Unplug size={14} /> {t('pv.disconnect')}
              </button>
            )}
            {current.custom && (
              <button
                className="btn"
                onClick={async () => {
                  const list = (config?.customProviders as { id: string }[] | undefined) ?? [];
                  await updateConfig({ customProviders: list.filter((c) => c.id !== current.id) });
                  setSelected(null);
                  await load();
                }}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>

          {result && (
            <div className={`pv-result ${result.ok ? 'ok' : 'error'}`}>
              {result.ok ? <CircleCheck size={16} /> : <CircleX size={16} />}
              <span>
                {result.ok
                  ? result.verified === false
                    ? t('pv.okUnverified')
                    : t('pv.ok', { n: result.models, ms: result.latencyMs })
                  : result.error}
              </span>
            </div>
          )}

          {result?.ok && groupedModels.length > 0 && (
            <div className="pv-form">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {groupedModels.map((m) => (
                  <option key={m.ref} value={m.ref}>
                    {m.name} — {m.ref}
                  </option>
                ))}
              </select>
              <button
                className="btn primary"
                disabled={!model || model === defaultRef}
                onClick={async () => {
                  await updateConfig({ model: { default: model } });
                  toast(t('pv.defaultSet', { model }));
                  onChanged?.();
                }}
              >
                {model === defaultRef ? t('pv.isDefault') : t('pv.useDefault')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function rank(id: string): number {
  const i = ORDER.indexOf(id);
  return i === -1 ? ORDER.length : i;
}
