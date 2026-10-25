import { useMemo, useState } from 'react';
import {
  Archive,
  BookOpen,
  Brain,
  CalendarClock,
  ChartColumn,
  Copy,
  Download,
  Ellipsis,
  FileText,
  GitFork,
  List,
  MessageSquare,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Puzzle,
  Search,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import { deleteSession, newChat, openSession, renameSession, savePref, setState, toast, togglePin, useStore, refreshSessions, type View } from '../lib/store';
import { downloadUrl, get, patch, post } from '../lib/api';
import { relTime } from '../lib/format';
import { t } from '../lib/i18n';
import type { Session } from '../lib/types';
import { Menu, MenuItem } from './ui';

const NAV: { id: View; icon: typeof Puzzle; key: string }[] = [
  { id: 'skills', icon: Puzzle, key: 'nav.skills' },
  { id: 'messaging', icon: MessageSquare, key: 'nav.messaging' },
  { id: 'artifacts', icon: FileText, key: 'nav.artifacts' },
  { id: 'automations', icon: CalendarClock, key: 'nav.automations' },
  { id: 'memory', icon: Brain, key: 'nav.memory' },
  { id: 'insights', icon: ChartColumn, key: 'nav.insights' },
];

function SessionItem({ s, active, running, needsInput }: { s: Session; active: boolean; running: boolean; needsInput: boolean }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  return (
    <div
      className={`session-item ${active ? 'active' : ''}`}
      onClick={(e) => {
        if (e.shiftKey) {
          void togglePin(s);
          toast(s.pinned ? 'Unpinned' : 'Pinned', 'info');
          return;
        }
        openSession(s.id);
      }}
      onDoubleClick={() => setEditing(true)}
      title={s.title}
    >
      <span className={`dot ${running ? 'running' : ''} ${needsInput ? 'attention' : ''}`} />
      {editing ? (
        <input
          className="inline-edit"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => {
            setEditing(false);
            if (title.trim() && title !== s.title) void renameSession(s.id, title.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setTitle(s.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="session-title">{s.title}</span>
      )}
      <span className="session-time">{relTime(s.updatedAt)}</span>
      <span onClick={(e) => e.stopPropagation()}>
        <Menu
          align="right"
          trigger={(open) => (
            <button className="icon-btn tiny session-more" onClick={open} aria-label="More">
              <Ellipsis size={14} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<Pencil size={14} />} onClick={() => (close(), setEditing(true))}>
                {t('common.rename')}
              </MenuItem>
              <MenuItem icon={s.pinned ? <PinOff size={14} /> : <Pin size={14} />} onClick={() => (close(), void togglePin(s))}>
                {s.pinned ? 'Unpin' : 'Pin'}
              </MenuItem>
              <MenuItem
                icon={<GitFork size={14} />}
                onClick={async () => {
                  close();
                  const f = await post<Session>(`/api/sessions/${s.id}/fork`);
                  refreshSessions();
                  openSession(f.id);
                  toast('Forked conversation');
                }}
              >
                Fork
              </MenuItem>
              <MenuItem
                icon={<Download size={14} />}
                onClick={() => {
                  close();
                  window.open(downloadUrl(`/api/sessions/${s.id}/export?format=md`), '_blank');
                  toast('Session exported');
                }}
              >
                {t('common.export')} (Markdown)
              </MenuItem>
              <MenuItem
                icon={<Copy size={14} />}
                onClick={() => {
                  close();
                  window.open(downloadUrl(`/api/sessions/${s.id}/export?format=json`), '_blank');
                }}
              >
                {t('common.export')} (JSON)
              </MenuItem>
              <MenuItem
                icon={<Archive size={14} />}
                onClick={async () => {
                  close();
                  await patch(`/api/sessions/${s.id}`, { archived: true });
                  refreshSessions();
                  toast('Archived');
                }}
              >
                Archive
              </MenuItem>
              <MenuItem
                danger
                icon={<Trash2 size={14} />}
                onClick={() => {
                  close();
                  if (confirm(`Delete "${s.title}"?`)) void deleteSession(s.id);
                }}
              >
                {t('common.delete')}
              </MenuItem>
            </>
          )}
        </Menu>
      </span>
    </div>
  );
}

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const currentId = useStore((s) => s.currentId);
  const view = useStore((s) => s.view);
  const running = useStore((s) => s.running);
  const permissions = useStore((s) => s.permissions);
  const clarify = useStore((s) => s.clarify);
  const groupByProject = useStore((s) => s.groupByProject);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const runningIds = new Set(running.map((r) => r.sessionId));
  const attention = new Set([...permissions.map((p) => p.sessionId), ...clarify.map((c) => c.sessionId)]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => !s.parentId && (!q || s.title.toLowerCase().includes(q)));
  }, [sessions, query]);
  const pinned = filtered.filter((s) => s.pinned);
  const rest = filtered.filter((s) => !s.pinned);
  const groups = useMemo(() => {
    if (!groupByProject) return [{ name: '', items: rest }];
    const map = new Map<string, Session[]>();
    for (const s of rest) {
      const key = s.source.startsWith('desktop') || s.source === 'cli' || s.source === 'api' ? s.project : s.source.split(':')[0] ?? s.project;
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()].map(([name, items]) => ({ name, items }));
  }, [rest, groupByProject]);

  const item = (s: Session) => <SessionItem key={s.id} s={s} active={view === 'chat' && currentId === s.id} running={runningIds.has(s.id)} needsInput={attention.has(s.id)} />;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button
          className="icon-btn"
          title="Toggle sidebar (⌘B)"
          onClick={() => {
            savePref('sidebarOpen', false);
            setState({ sidebarOpen: false });
          }}
        >
          <PanelLeft size={16} />
        </button>
        <button className={`icon-btn ${searching ? 'active' : ''}`} title="Search chats" onClick={() => setSearching((v) => !v)}>
          <Search size={16} />
        </button>
        <div className="flex-1" />
        <button className="icon-btn" title="Command palette (⌘K)" onClick={() => setState({ paletteOpen: true })}>
          <BookOpen size={15} />
        </button>
      </div>
      {searching && (
        <div className="sidebar-search">
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('nav.search')} onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), setSearching(false))} />
          {query && (
            <button className="icon-btn tiny" onClick={() => setQuery('')}>
              <X size={12} />
            </button>
          )}
        </div>
      )}
      <nav className="nav">
        <button className={`nav-item ${view === 'chat' && !currentId ? 'active' : ''}`} onClick={() => newChat()}>
          <SquarePen size={16} />
          <span>{t('nav.new')}</span>
          <kbd className="nav-kbd">⌘N</kbd>
        </button>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${view === n.id ? 'active' : ''}`} onClick={() => setState({ view: n.id })}>
            <n.icon size={16} />
            <span>{t(n.key)}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-scroll">
        <div className="section-head">
          <span className="section-square" />
          {t('nav.pinned')}
        </div>
        {pinned.length ? pinned.map(item) : <div className="sidebar-hint">↖ {t('nav.pinHint')}</div>}
        <div className="section-head">
          <span className="section-square" />
          {t('nav.agents')} <span className="count">{rest.length}</span>
          <div className="flex-1" />
          <button
            className={`icon-btn tiny ${groupByProject ? 'active' : ''}`}
            title="Group by project"
            onClick={() => {
              savePref('groupByProject', !groupByProject);
              setState({ groupByProject: !groupByProject });
            }}
          >
            <List size={13} />
          </button>
        </div>
        {groups.map((g) => (
          <div key={g.name || 'all'}>
            {g.name && (
              <div className="group-head">
                {g.name} <span className="count">{g.items.length}</span>
              </div>
            )}
            {g.items.map(item)}
          </div>
        ))}
        {!sessions.length && <div className="sidebar-hint">No conversations yet</div>}
        {sessions.length > 0 && (
          <button
            className="sidebar-link"
            onClick={async () => {
              const archived = await fetchArchived();
              if (!archived.length) return toast('No archived conversations', 'info');
              if (confirm(`Restore ${archived.length} archived conversation(s)?`)) {
                await Promise.all(archived.map((a) => patch(`/api/sessions/${a.id}`, { archived: false })));
                refreshSessions();
              }
            }}
          >
            <Archive size={12} /> Archived
          </button>
        )}
      </div>
    </aside>
  );
}

async function fetchArchived(): Promise<Session[]> {
  const all = await get<Session[]>('/api/sessions?archived=1');
  return all.filter((s) => s.archived);
}

