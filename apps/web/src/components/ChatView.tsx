import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Download, GitFork, KeyRound, Minimize2, Pencil, RefreshCw, RotateCcw, Trash2, Undo2, ListTodo, Bug, Search as SearchIcon, Newspaper, CalendarClock, Code, Feather } from 'lucide-react';
import { chatOf, deleteSession, loadSession, openSession, refreshSessions, renameSession, sendMessage, setState, toast, undoLast, useStore } from '../lib/store';
import { downloadUrl, post } from '../lib/api';
import { t } from '../lib/i18n';
import type { Message, Part } from '../lib/types';
import { AssistantTurn, Markdown, ThinkingBlock, TodoList, ToolCard, UserMessage } from './Message';
import { ClarifyCard, PermissionCard, SubagentPanel } from './Cards';
import { Composer } from './Composer';
import { Menu, MenuItem } from './ui';
import { KronosMark } from './Logo';

type Item =
  | { kind: 'user'; m: Message }
  | { kind: 'assistant'; ms: Message[] }
  | { kind: 'notice'; m: Message }
  | { kind: 'summary'; m: Message };

function buildItems(messages: Message[]): { items: Item[]; results: Map<string, Extract<Part, { type: 'tool_result' }>> } {
  const results = new Map<string, Extract<Part, { type: 'tool_result' }>>();
  for (const m of messages) for (const p of m.parts) if (p.type === 'tool_result') results.set(p.toolCallId, p);
  const items: Item[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.meta?.kind === 'summary') items.push({ kind: 'summary', m });
      else if (m.parts.some((p) => p.type !== 'tool_result')) items.push({ kind: 'user', m });
    } else if (m.role === 'assistant') {
      const last = items[items.length - 1];
      if (last?.kind === 'assistant') last.ms.push(m);
      else items.push({ kind: 'assistant', ms: [m] });
    } else if (m.role === 'system' && m.meta?.kind === 'notice') {
      items.push({ kind: 'notice', m });
    }
  }
  return { items, results };
}

const SUGGESTIONS = [
  { icon: Code, title: 'Understand this codebase', prompt: 'Explore this project and give me a clear overview: what it does, how it is structured, how to build and test it, and the riskiest parts.' },
  { icon: Bug, title: 'Fix failing tests', prompt: 'Run the test suite, find out why tests fail, fix the root causes and re-run until green. Summarize the fixes.' },
  { icon: SearchIcon, title: 'Deep research', prompt: 'Research the latest developments on <topic> using several sources in parallel and write a cited briefing with key takeaways.' },
  { icon: CalendarClock, title: 'Daily briefing', prompt: 'Every weekday at 8am, search the web for news about AI agents and send me a 5-bullet summary.' },
  { icon: Newspaper, title: 'Draft release notes', prompt: 'Look at the recent git commits and draft polished release notes grouped by features, fixes and breaking changes.' },
  { icon: Feather, title: 'Remember my preferences', prompt: 'Interview me briefly about how I like to work (tools, style, tone) and save what you learn to your memory.' },
];

function Welcome() {
  const status = useStore((s) => s.status);
  return (
    <div className="welcome">
      <KronosMark size={68} />
      <h1>{t('chat.welcome')}</h1>
      <p className="muted">{t('chat.welcomeSub')}</p>
      {status?.demo && (
        <div className="demo-banner">
          <span>{t('chat.demo')}</span>
          <button className="btn small primary" onClick={() => setState({ settings: 'keys' })}>
            <KeyRound size={13} /> {t('chat.addKey')}
          </button>
        </div>
      )}
      <Composer centered />
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s.title} className="suggestion" onClick={() => void sendMessage(s.prompt)}>
            <s.icon size={16} />
            <span>{s.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatHeader({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session?.title ?? '');
  useEffect(() => setTitle(session?.title ?? ''), [session?.title]);
  if (!session) return <div className="chat-header" />;
  return (
    <div className="chat-header">
      {editing ? (
        <input
          className="title-input"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (title.trim() && title !== session.title) void renameSession(sessionId, title.trim());
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <Menu
          trigger={(open) => (
            <button className="title-btn" onClick={open}>
              <span>{session.title}</span>
              <ChevronDown size={14} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<Pencil size={14} />} onClick={() => (close(), setEditing(true))}>
                {t('common.rename')}
              </MenuItem>
              <MenuItem icon={<Undo2 size={14} />} onClick={() => (close(), void undoLast(sessionId))}>
                Undo last turn
              </MenuItem>
              <MenuItem
                icon={<RotateCcw size={14} />}
                onClick={async () => {
                  close();
                  const r = await post<{ text: string; removed: number }>(`/api/sessions/${sessionId}/undo`);
                  await loadSession(sessionId);
                  if (r.text) await sendMessage(r.text);
                }}
              >
                Retry last turn
              </MenuItem>
              <MenuItem
                icon={<Minimize2 size={14} />}
                onClick={async () => {
                  close();
                  toast('Compacting…', 'info');
                  await post(`/api/sessions/${sessionId}/compact`);
                  await loadSession(sessionId);
                }}
              >
                Compact context
              </MenuItem>
              <MenuItem
                icon={<RefreshCw size={14} />}
                onClick={async () => {
                  close();
                  await post(`/api/sessions/${sessionId}/refresh`);
                  toast('Context will be rebuilt (memory, skills, tools) on the next message', 'info');
                }}
              >
                Refresh memory & skills
              </MenuItem>
              <MenuItem
                icon={<GitFork size={14} />}
                onClick={async () => {
                  close();
                  const f = await post<{ id: string }>(`/api/sessions/${sessionId}/fork`);
                  refreshSessions();
                  openSession(f.id);
                }}
              >
                Fork conversation
              </MenuItem>
              <MenuItem
                icon={<Download size={14} />}
                onClick={() => {
                  close();
                  window.open(downloadUrl(`/api/sessions/${sessionId}/export?format=md`), '_blank');
                  toast('Session exported');
                }}
              >
                {t('common.export')}
              </MenuItem>
              <MenuItem danger icon={<Trash2 size={14} />} onClick={() => (close(), confirm(`Delete "${session.title}"?`) && void deleteSession(sessionId))}>
                {t('common.delete')}
              </MenuItem>
            </>
          )}
        </Menu>
      )}
      <span className="chat-cwd" title={session.cwd}>
        {session.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}
      </span>
    </div>
  );
}

export function ChatView() {
  const currentId = useStore((s) => s.currentId);
  const chat = useStore((s) => chatOf(s.currentId));
  const permissions = useStore((s) => s.permissions.filter((p) => p.sessionId === s.currentId));
  const clarify = useStore((s) => s.clarify.filter((c) => c.sessionId === s.currentId));
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { items, results } = useMemo(() => buildItems(chat.messages), [chat.messages]);
  const subagents = Object.values(chat.subagents);
  const activeTodos = chat.todos.length > 0 && chat.todos.some((td) => td.status !== 'completed' && td.status !== 'cancelled');

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [currentId]);

  if (!currentId || (!chat.messages.length && !chat.pendingUser && !chat.running && chat.loaded)) {
    return (
      <div className="chat">
        <div className="chat-scroll">
          <Welcome />
        </div>
      </div>
    );
  }

  const lastIsAssistant = items[items.length - 1]?.kind === 'assistant';
  const live = chat.live;
  return (
    <div className="chat">
      <ChatHeader sessionId={currentId} />
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="thread">
          {items.map((it, i) => {
            if (it.kind === 'user') return <UserMessage key={it.m.id} message={it.m} />;
            if (it.kind === 'summary')
              return (
                <details key={it.m.id} className="summary-divider">
                  <summary>— {t('chat.compacted')} —</summary>
                  <Markdown text={it.m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').replace(/<\/?[a-z_]+>/g, '')} />
                </details>
              );
            if (it.kind === 'notice')
              return (
                <div key={it.m.id} className="notice">
                  {it.m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}
                </div>
              );
            return <AssistantTurn key={it.ms[0]?.id ?? i} messages={it.ms} results={results} tools={chat.tools} running={chat.running && i === items.length - 1} />;
          })}
          {chat.pendingUser && <UserMessage message={chat.pendingUser} pending />}
          {chat.running && (
            <div className={`assistant-turn live ${lastIsAssistant ? 'continued' : ''}`}>
              {live.map((li, i) => {
                if (li.kind === 'thinking') return <ThinkingBlock key={i} text={li.text} live={i === live.length - 1} />;
                if (li.kind === 'text') return <Markdown key={i} text={li.text} />;
                const tl = chat.tools[li.id];
                return tl ? <ToolCard key={li.id} id={li.id} name={tl.name} input={tl.input} live={tl} pending /> : null;
              })}
              {!live.length && <ThinkingBlock text="" live />}
            </div>
          )}
          {subagents.length > 0 && chat.running && <SubagentPanel agents={subagents} />}
          {chat.notices.filter((n) => n.level !== 'info').slice(-2).map((n) => (
            <div key={n.id} className={`notice ${n.level}`}>
              {n.text}
            </div>
          ))}
          {permissions.map((p) => (
            <PermissionCard key={p.requestId} req={p} />
          ))}
          {clarify.map((c) => (
            <ClarifyCard key={c.requestId} req={c} />
          ))}
        </div>
      </div>
      {activeTodos && (
        <div className="todo-float">
          <div className="todo-float-head">
            <ListTodo size={13} /> Plan · {chat.todos.filter((td) => td.status === 'completed').length}/{chat.todos.length}
          </div>
          <TodoList todos={chat.todos} />
        </div>
      )}
      <Composer />
    </div>
  );
}
