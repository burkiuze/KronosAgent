import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { CalendarClock, ChartColumn, Brain, FileText, MessageSquare, Moon, Palette, Plus, Puzzle, Search, Settings, Sun, PanelRight, SquareTerminal, KeyRound, Languages } from 'lucide-react';
import { get } from '../lib/api';
import { getState, newChat, openSession, savePref, setState, useStore } from '../lib/store';
import { THEMES } from '../lib/themes';
import { updateConfig } from '../lib/config';
import { getLang, setLang, t } from '../lib/i18n';
import { relTime } from '../lib/format';

interface Action {
  id: string;
  label: string;
  hint?: string;
  icon: ReactElement;
  run: () => void;
}

interface Hit {
  sessionId: string;
  title: string;
  snippet: string;
  createdAt: number;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const sessions = useStore((s) => s.sessions);
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const [hits, setHits] = useState<Hit[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setIndex(0);
      setHits([]);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 3) {
      setHits([]);
      return;
    }
    const id = setTimeout(() => void get<Hit[]>(`/api/search?q=${encodeURIComponent(q)}&limit=8`).then(setHits).catch(() => setHits([])), 200);
    return () => clearTimeout(id);
  }, [q, open]);

  const close = () => setState({ paletteOpen: false });
  const actions: Action[] = useMemo(
    () => [
      { id: 'new', label: t('nav.new'), hint: '⌘N', icon: <Plus size={15} />, run: () => newChat() },
      { id: 'skills', label: t('nav.skills'), icon: <Puzzle size={15} />, run: () => setState({ view: 'skills' }) },
      { id: 'messaging', label: t('nav.messaging'), icon: <MessageSquare size={15} />, run: () => setState({ view: 'messaging' }) },
      { id: 'artifacts', label: t('nav.artifacts'), icon: <FileText size={15} />, run: () => setState({ view: 'artifacts' }) },
      { id: 'automations', label: t('nav.automations'), icon: <CalendarClock size={15} />, run: () => setState({ view: 'automations' }) },
      { id: 'memory', label: t('nav.memory'), icon: <Brain size={15} />, run: () => setState({ view: 'memory' }) },
      { id: 'insights', label: t('nav.insights'), icon: <ChartColumn size={15} />, run: () => setState({ view: 'insights' }) },
      { id: 'settings', label: t('settings.title'), hint: '⌘,', icon: <Settings size={15} />, run: () => setState({ settings: 'model' }) },
      { id: 'keys', label: 'API keys', icon: <KeyRound size={15} />, run: () => setState({ settings: 'keys' }) },
      { id: 'files', label: 'Toggle files panel', hint: '⌘J', icon: <PanelRight size={15} />, run: () => setState((s) => (savePref('rightPanel', s.rightPanel ? null : 'files'), { rightPanel: s.rightPanel ? null : 'files' })) },
      { id: 'terminal', label: 'Open terminal', icon: <SquareTerminal size={15} />, run: () => (savePref('rightPanel', 'terminal'), setState({ rightPanel: 'terminal' })) },
      { id: 'light', label: 'Light mode', icon: <Sun size={15} />, run: () => void updateConfig({ ui: { mode: 'light' } }, true) },
      { id: 'dark', label: 'Dark mode', icon: <Moon size={15} />, run: () => void updateConfig({ ui: { mode: 'dark' } }, true) },
      { id: 'lang', label: getLang() === 'tr' ? 'Switch to English' : 'Türkçe arayüze geç', icon: <Languages size={15} />, run: () => setLang(getLang() === 'tr' ? 'en' : 'tr') },
      ...THEMES.map((th) => ({ id: `theme-${th.id}`, label: `Theme: ${th.name}`, icon: <Palette size={15} />, run: () => void updateConfig({ ui: { theme: th.id } }, true) })),
    ],
    [open],
  );

  const ql = q.toLowerCase();
  const filteredActions = actions.filter((a) => !ql || a.label.toLowerCase().includes(ql));
  const sessionItems: Action[] = sessions
    .filter((s) => !s.parentId && (!ql || s.title.toLowerCase().includes(ql)))
    .slice(0, ql ? 8 : 5)
    .map((s) => ({ id: `s-${s.id}`, label: s.title, hint: relTime(s.updatedAt), icon: <MessageSquare size={15} />, run: () => openSession(s.id) }));
  const hitItems: Action[] = hits
    .filter((h) => !sessionItems.some((s) => s.id === `s-${h.sessionId}`))
    .map((h) => ({ id: `h-${h.sessionId}-${h.createdAt}`, label: `${h.title} — ${h.snippet}`, hint: relTime(h.createdAt), icon: <Search size={15} />, run: () => openSession(h.sessionId) }));
  const all = [...filteredActions, ...sessionItems, ...hitItems];

  if (!open) return null;
  const run = (a?: Action) => {
    if (!a) return;
    close();
    a.run();
  };
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={16} />
          <input
            ref={input}
            value={q}
            placeholder={t('palette.placeholder')}
            onChange={(e) => {
              setQ(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(all.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (all[index]) run(all[index]);
                else if (q.trim() && getState()) {
                  close();
                  newChat();
                }
              } else if (e.key === 'Escape') close();
            }}
          />
        </div>
        <div className="palette-list">
          {all.map((a, i) => (
            <button key={a.id} className={`palette-item ${i === index ? 'active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => run(a)}>
              {a.icon}
              <span className="palette-label">{a.label}</span>
              {a.hint && <kbd>{a.hint}</kbd>}
            </button>
          ))}
          {!all.length && <div className="muted pad">No results</div>}
        </div>
      </div>
    </div>
  );
}
