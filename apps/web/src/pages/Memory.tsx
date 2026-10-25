import { useEffect, useState, type ReactElement } from 'react';
import { Brain, Plus, Save, Trash2, UserRound, Feather } from 'lucide-react';
import { get, put } from '../lib/api';
import { toast } from '../lib/store';
import { relTime } from '../lib/format';

interface MemoryData {
  memory: { entries: string[]; usage: { chars: number; limit: number } };
  user: { entries: string[]; usage: { chars: number; limit: number } };
  changes: { ts: number; target: string; action: string; content?: string; old?: string }[];
}

function Store({ title, icon, target, data, onSaved, description }: { title: string; icon: ReactElement; target: 'memory' | 'user'; data: MemoryData['memory']; onSaved: () => void; description: string }) {
  const [entries, setEntries] = useState<string[]>(data.entries);
  const [draft, setDraft] = useState('');
  const dirty = JSON.stringify(entries) !== JSON.stringify(data.entries);
  useEffect(() => setEntries(data.entries), [data.entries.join('\u0000')]);
  const used = entries.join('\n§\n').length;
  const pct = Math.min(100, Math.round((used / data.usage.limit) * 100));
  const save = async (list: string[]) => {
    try {
      await put(`/api/memory/${target}`, { entries: list });
      toast('Memory saved');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="memory-store">
      <div className="memory-head">
        {icon}
        <div>
          <h3>{title}</h3>
          <div className="muted small">{description}</div>
        </div>
      </div>
      <div className="meter" title={`${used}/${data.usage.limit} characters`}>
        <span style={{ width: `${pct}%` }} className={pct > 90 ? 'hot' : ''} />
      </div>
      <div className="muted small">
        {pct}% · {used.toLocaleString()}/{data.usage.limit.toLocaleString()} chars
      </div>
      <div className="memory-entries">
        {entries.map((e, i) => (
          <div key={i} className="memory-entry">
            <textarea value={e} rows={Math.min(6, Math.max(1, Math.ceil(e.length / 60)))} onChange={(ev) => setEntries((x) => x.map((y, j) => (j === i ? ev.target.value : y)))} />
            <button className="icon-btn tiny" onClick={() => setEntries((x) => x.filter((_, j) => j !== i))} title="Remove">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {!entries.length && <div className="muted pad">Empty — Kronos fills this as it learns.</div>}
      </div>
      <div className="memory-add">
        <input
          value={draft}
          placeholder="Add an entry…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              const next = [...entries, draft.trim()];
              setEntries(next);
              setDraft('');
              void save(next);
            }
          }}
        />
        <button
          className="btn small"
          disabled={!draft.trim()}
          onClick={() => {
            const next = [...entries, draft.trim()];
            setEntries(next);
            setDraft('');
            void save(next);
          }}
        >
          <Plus size={12} />
        </button>
        {dirty && (
          <button className="btn small primary" onClick={() => void save(entries)}>
            <Save size={12} /> Save
          </button>
        )}
      </div>
    </div>
  );
}

export function MemoryPage() {
  const [data, setData] = useState<MemoryData | null>(null);
  const [soul, setSoul] = useState('');
  const [soulSaved, setSoulSaved] = useState('');
  const load = () => void get<MemoryData>('/api/memory').then(setData);
  useEffect(() => {
    load();
    void get<{ content: string }>('/api/soul').then((r) => {
      setSoul(r.content);
      setSoulSaved(r.content);
    });
  }, []);
  return (
    <div className="page">
      <div className="page-head">
        <Brain size={18} />
        <div>
          <h2>Memory</h2>
          <p className="muted">Bounded, curated, persistent. Loaded into every new session as a frozen snapshot; Kronos edits it with the memory tool and you can edit it here.</p>
        </div>
      </div>
      <div className="page-body">
        {data && (
          <div className="memory-grid">
            <Store title="MEMORY.md" icon={<Brain size={16} />} target="memory" data={data.memory} onSaved={load} description="Kronos' own notes: environment, conventions, lessons." />
            <Store title="USER.md" icon={<UserRound size={16} />} target="user" data={data.user} onSaved={load} description="What Kronos knows about you: preferences, style, projects." />
          </div>
        )}
        <div className="memory-store soul">
          <div className="memory-head">
            <Feather size={16} />
            <div>
              <h3>SOUL.md — persona</h3>
              <div className="muted small">Kronos' personality, voice and standing instructions for this profile.</div>
            </div>
            <div className="flex-1" />
            {soul !== soulSaved && (
              <button
                className="btn small primary"
                onClick={async () => {
                  await put('/api/soul', { content: soul });
                  setSoulSaved(soul);
                  toast('Persona saved — applies to new sessions');
                }}
              >
                <Save size={12} /> Save
              </button>
            )}
          </div>
          <textarea
            className="soul-editor"
            value={soul}
            onChange={(e) => setSoul(e.target.value)}
            placeholder={'You are Kronos, a calm, precise and witty assistant.\nYou speak Turkish with me unless I write in English.\nYou always verify before claiming success.'}
          />
        </div>
        {data && data.changes.length > 0 && (
          <>
            <h4 className="list-cat">Recent memory changes</h4>
            {data.changes.slice(0, 20).map((c, i) => (
              <div key={i} className="list-row">
                <span className={`badge ${c.action === 'remove' ? 'error' : c.action === 'add' ? 'ok' : 'neutral'}`}>{c.action}</span>
                <div className="list-main">
                  <div className="list-desc">
                    <b>{c.target}</b> · {c.content ?? c.old ?? ''}
                  </div>
                </div>
                <span className="muted small">{relTime(c.ts)}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
