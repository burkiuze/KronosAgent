import { useEffect, useMemo, useState } from 'react';
import { Download, History, Plus, RefreshCw, RotateCcw, Sparkles, TriangleAlert, X } from 'lucide-react';
import { del, get, patch, post, put } from '../lib/api';
import { setState, toast, useStore } from '../lib/store';
import { t } from '../lib/i18n';
import type { SkillInfo, ToolsetStatus } from '../lib/types';
import { Badge, Empty, Field, Modal, SearchBox, Tabs, Toggle } from '../components/ui';
import { Markdown } from '../components/Message';
import { parseFrontmatter } from '../lib/frontmatter';

interface PruneCandidate {
  name: string;
  reason: string;
  uses: number;
  ok: number;
  failed: number;
}

interface Revision {
  version: string;
  savedAt: number;
  reason: string;
}

function SkillDetail({ skill, onClose, onChanged }: { skill: SkillInfo; onClose: () => void; onChanged: () => void }) {
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const path = `/api/skills/${encodeURIComponent(skill.name)}`;
  const reload = () => {
    void get<{ content: string }>(path).then((r) => setContent(r.content));
    if (skill.editable) void get<{ revisions: Revision[] }>(`${path}/history`).then((r) => setRevisions(r.revisions));
  };
  useEffect(reload, [skill.name]);
  const outcomes = (skill.ok ?? 0) + (skill.failed ?? 0);
  const { body } = parseFrontmatter(content);
  return (
    <Modal open onClose={onClose} wide>
      <div className="skill-detail">
        <div className="skill-detail-head">
          <Sparkles size={18} className="accent" />
          <div>
            <h2>{skill.name}</h2>
            <div className="muted">{skill.description}</div>
          </div>
        </div>
        <div className="chips">
          <Badge>{skill.category}</Badge>
          <Badge tone={skill.source === 'user' ? 'accent' : 'neutral'}>{skill.source}</Badge>
          {skill.version && <Badge>v{skill.version}</Badge>}
          {skill.uses ? <Badge tone="ok">{skill.uses} uses</Badge> : null}
          {outcomes > 0 && <Badge tone={(skill.failed ?? 0) > (skill.ok ?? 0) ? 'warn' : 'ok'}>{skill.ok ?? 0}/{outcomes} runs succeeded</Badge>}
          {skill.tags.map((tg) => (
            <Badge key={tg}>#{tg}</Badge>
          ))}
        </div>
        {editing ? (
          <textarea className="skill-editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        ) : (
          <div className="skill-body">
            <Markdown text={body} />
          </div>
        )}
        {skill.files.length > 0 && <div className="muted small">Files: {skill.files.join(', ')}</div>}
        {revisions.length > 0 && (
          <div className="skill-history">
            <div className="skill-history-title">
              <History size={13} /> Earlier versions
            </div>
            {revisions.slice(0, 6).map((r) => (
              <div key={`${r.version}-${r.savedAt}`} className="skill-history-row">
                <span className="mono">v{r.version}</span>
                <span className="muted small">
                  {new Date(r.savedAt).toLocaleString()} · before {r.reason}
                </span>
                <div className="flex-1" />
                <button
                  className="btn small"
                  onClick={async () => {
                    await post(`${path}/rollback`, { version: r.version });
                    toast(`Restored v${r.version}`);
                    reload();
                    onChanged();
                  }}
                >
                  <RotateCcw size={12} /> Restore
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <span className="muted small">{skill.path}</span>
          <div className="flex-1" />
          {editing ? (
            <button
              className="btn primary"
              onClick={async () => {
                const parsed = parseFrontmatter(draft);
                await put(`/api/skills/${encodeURIComponent(skill.name)}`, { body: parsed.body, description: String(parsed.data.description ?? skill.description) });
                toast('Skill saved');
                setEditing(false);
                setContent(draft);
                onChanged();
              }}
            >
              {t('common.save')}
            </button>
          ) : (
            <button
              className="btn"
              onClick={() => {
                setDraft(content);
                setEditing(true);
              }}
            >
              {t('common.edit')}
            </button>
          )}
          {skill.editable && (
            <button
              className="btn danger-outline"
              onClick={async () => {
                if (!confirm(`Delete skill ${skill.name}?`)) return;
                await del(`/api/skills/${encodeURIComponent(skill.name)}`);
                onChanged();
                onClose();
              }}
            >
              {t('common.delete')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function NewSkill({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [body, setBody] = useState('# When to use\n\n# Steps\n1. \n\n# Pitfalls\n\n# Verification\n');
  return (
    <Modal open onClose={onClose} wide>
      <h2>New skill</h2>
      <p className="muted">Skills are reusable procedures Kronos loads on demand. Kronos also writes and improves skills by itself after complex tasks.</p>
      <div className="grid2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="deploy-to-fly" />
        </Field>
        <Field label="Category">
          <input value={category} onChange={(e) => setCategory(e.target.value)} />
        </Field>
      </div>
      <Field label="Description (when should Kronos use it?)">
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Deploy a Node app to Fly.io with zero downtime" />
      </Field>
      <Field label="Instructions (Markdown)">
        <textarea className="skill-editor" value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <div className="modal-actions">
        <div className="flex-1" />
        <button className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="btn primary"
          disabled={!name || !description}
          onClick={async () => {
            try {
              await post('/api/skills', { name, description, body, category });
              toast('Skill created');
              onDone();
              onClose();
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }}
        >
          Create
        </button>
      </div>
    </Modal>
  );
}

function InstallSkill({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose}>
      <h2>Install skills</h2>
      <p className="muted">From a git URL, GitHub shorthand (owner/repo or owner/repo/path) or a local folder. Compatible with the open SKILL.md standard (Anthropic, Hermes, OpenClaw, agentskills.io).</p>
      <Field label="Source">
        <input autoFocus value={source} onChange={(e) => setSource(e.target.value)} placeholder="anthropics/skills/skills" />
      </Field>
      <div className="modal-actions">
        <div className="flex-1" />
        <button
          className="btn primary"
          disabled={!source || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const list = await post<SkillInfo[]>('/api/skills/install', { source });
              toast(`Installed ${list.length} skill(s)`);
              onDone();
              onClose();
            } catch (e) {
              toast((e as Error).message, 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Installing…' : t('common.install')}
        </button>
      </div>
    </Modal>
  );
}

function SkillsTab({ query }: { query: string }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [cat, setCat] = useState('all');
  const [open, setOpen] = useState<SkillInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [stale, setStale] = useState<PruneCandidate[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const load = () => {
    void get<{ skills: SkillInfo[] }>('/api/skills').then((r) => setSkills(r.skills));
    void get<PruneCandidate[]>('/api/skills/prune').then(setStale).catch(() => setStale([]));
  };
  useEffect(load, []);
  const cats = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of skills) m[s.category] = (m[s.category] ?? 0) + 1;
    return Object.entries(m).sort();
  }, [skills]);
  const q = query.toLowerCase();
  const list = skills.filter((s) => (cat === 'all' || s.category === cat) && (!q || `${s.name} ${s.description} ${s.tags.join(' ')}`.toLowerCase().includes(q)));
  const grouped = useMemo(() => {
    const m = new Map<string, SkillInfo[]>();
    for (const s of list) m.set(s.category, [...(m.get(s.category) ?? []), s]);
    return [...m.entries()];
  }, [list]);
  return (
    <>
      <div className="filter-row">
        <Tabs value={cat} onChange={setCat} tabs={[{ id: 'all', label: t('common.all'), count: skills.length }, ...cats.map(([c, n]) => ({ id: c, label: c.charAt(0).toUpperCase() + c.slice(1), count: n }))]} />
        <div className="flex-1" />
        <button className="btn small" onClick={() => setInstalling(true)}>
          <Download size={13} /> {t('common.install')}
        </button>
        <button className="btn small primary" onClick={() => setCreating(true)}>
          <Plus size={13} /> {t('common.new')}
        </button>
      </div>
      {stale.length > 0 && (
        <button className="skill-review" onClick={() => setReviewing(true)}>
          <TriangleAlert size={14} />
          <span>
            {stale.length} skill{stale.length > 1 ? 's' : ''} Kronos wrote {stale.length > 1 ? 'look' : 'looks'} unused or keep failing
          </span>
          <b>Review</b>
        </button>
      )}
      {grouped.map(([category, items]) => (
        <section key={category} className="list-section">
          <h4 className="list-cat">{category}</h4>
          {items.map((s) => (
            <div key={s.name} className="list-row clickable" onClick={() => setOpen(s)}>
              <div className="list-main">
                <div className="list-title">
                  {s.name}
                  {s.source !== 'bundled' && <span className="tag">{s.source}</span>}
                  {s.uses ? <span className="tag ok">{s.uses}×</span> : null}
                </div>
                <div className="list-desc">{s.description}</div>
              </div>
              <Toggle
                checked={s.enabled}
                onChange={async (v) => {
                  setSkills((x) => x.map((y) => (y.name === s.name ? { ...y, enabled: v } : y)));
                  await patch(`/api/skills/${encodeURIComponent(s.name)}`, { enabled: v });
                }}
              />
            </div>
          ))}
        </section>
      ))}
      {!list.length && <Empty title="No skills match" />}
      {open && <SkillDetail skill={open} onClose={() => setOpen(null)} onChanged={load} />}
      {creating && <NewSkill onClose={() => setCreating(false)} onDone={load} />}
      {installing && <InstallSkill onClose={() => setInstalling(false)} onDone={load} />}
      {reviewing && (
        <Modal open onClose={() => setReviewing(false)}>
          <h2>Review skills</h2>
          <p className="muted">Skills that stop helping are worth removing: they cost context and can mislead. Removed skills stay in history and can be restored.</p>
          {stale.map((p) => (
            <div key={p.name} className="list-row">
              <div className="list-main">
                <div className="list-title">{p.name}</div>
                <div className="list-desc">
                  {p.reason} · {p.uses} uses · {p.ok} ok · {p.failed} failed
                </div>
              </div>
              <button
                className="btn small danger-outline"
                onClick={async () => {
                  await del(`/api/skills/${encodeURIComponent(p.name)}`);
                  toast(`Removed ${p.name}`);
                  load();
                }}
              >
                Remove
              </button>
            </div>
          ))}
          {!stale.length && <Empty title="Nothing left to review" />}
        </Modal>
      )}
    </>
  );
}

function ToolsetsTab({ query }: { query: string }) {
  const [sets, setSets] = useState<ToolsetStatus[]>([]);
  const load = () => void get<ToolsetStatus[]>('/api/toolsets').then(setSets);
  useEffect(load, []);
  const q = query.toLowerCase();
  const shown = sets.filter((s) => s.tools.length && (!q || `${s.label} ${s.description} ${s.tools.map((x) => x.name).join(' ')}`.toLowerCase().includes(q)));
  const enabled = shown.filter((s) => s.enabled).length;
  return (
    <>
      <div className="filter-row">
        <span className="muted">{t('skills.enabledCount', { n: enabled, m: shown.length })}</span>
        <div className="flex-1" />
        <button className="btn small" onClick={() => setState({ settings: 'mcp' })}>
          + MCP server
        </button>
      </div>
      {shown.map((s) => (
        <div key={s.id} className="list-row">
          <div className="list-main">
            <div className="list-title">{s.label}</div>
            <div className="list-desc">{s.description}</div>
            <div className="tool-chips">
              {s.tools.map((tl) => (
                <code key={tl.name} className={tl.available ? '' : 'unavailable'} title={tl.reason ?? tl.description}>
                  {tl.name}
                </code>
              ))}
            </div>
          </div>
          <div className="list-side">
            <Badge tone={s.enabled ? 'ok' : 'neutral'}>{s.enabled ? t('common.enabled') : t('common.disabled')}</Badge>
            <Badge tone={s.available ? 'neutral' : 'warn'}>{s.available ? t('common.configured') : t('common.needsKeys')}</Badge>
            <Toggle
              checked={s.enabled}
              onChange={async (v) => {
                setSets((x) => x.map((y) => (y.id === s.id ? { ...y, enabled: v } : y)));
                await patch(`/api/toolsets/${s.id}`, { enabled: v });
              }}
            />
          </div>
        </div>
      ))}
    </>
  );
}

export function SkillsPage() {
  const [tab, setTab] = useState<'skills' | 'toolsets'>('skills');
  const [query, setQuery] = useState('');
  useStore((s) => s.configVersion);
  return (
    <div className="page">
      <div className="page-top">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={tab === 'skills' ? t('skills.search') : 'Search toolsets…'}
          right={
            <button className="icon-btn tiny" onClick={() => setQuery('')} title={t('common.refresh')}>
              {query ? <X size={13} /> : <RefreshCw size={13} />}
            </button>
          }
        />
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'skills', label: t('nav.skills') }, { id: 'toolsets', label: t('skills.toolsets') }]} />
      </div>
      <div className="page-body">{tab === 'skills' ? <SkillsTab query={query} /> : <ToolsetsTab query={query} />}</div>
    </div>
  );
}
