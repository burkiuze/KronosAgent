import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Download, GitFork, Minimize2, Pencil, RefreshCw, RotateCcw, Trash2, Undo2, CircleCheck, Circle, LoaderCircle } from 'lucide-react';
import { chatOf, deleteSession, loadSession, openSession, refreshSessions, renameSession, sendMessage, setState, toast, undoLast, useStore } from '../lib/store';
import { downloadUrl, post } from '../lib/api';
import { t } from '../lib/i18n';
import { shortDuration, tokens as fmtTokens } from '../lib/format';
import type { Message, Part } from '../lib/types';
import { AssistantTurn, Markdown, StreamingMarkdown, ThinkingBlock, TodoList, ToolCard, UserMessage } from './Message';
import { ClarifyCard, PermissionCard, SubagentPanel } from './Cards';
import { Composer } from './Composer';
import { ConnectCard } from './ConnectCard';
import { Menu, MenuItem } from './ui';

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

function Welcome() {
  const needsProvider = useStore((s) => Boolean(s.status?.needsProvider));
  return (
    <div className="welcome">
      <h1 className="welcome-title">KRONOS AGENT</h1>
      <Composer centered />
      {needsProvider && <ConnectCard />}
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

/** Right-hand rail: the task at a glance and its live plan (like a PR checklist). */
const ProgressRail = memo(function ProgressRail({ sessionId }: { sessionId: string }) {
  const chat = useStore((s) => {
    const c = chatOf(s.currentId);
    return { running: c.running, todos: c.todos, usage: c.usage, runStartedAt: c.runStartedAt, lastRunMs: c.lastRunMs };
  });
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!chat.running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [chat.running]);
  const todos = chat.todos;
  const done = todos.filter((td) => td.status === 'completed').length;
  const usage = chat.usage ?? session?.usage;
  const total = usage ? usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0;
  const elapsed = chat.running && chat.runStartedAt ? now - chat.runStartedAt : chat.lastRunMs;
  const finished = !chat.running && todos.length > 0 && done === todos.length;
  const meta = [todos.length ? `${done}/${todos.length}` : '', elapsed ? shortDuration(elapsed) : '', total ? `${fmtTokens(total)} ${t('progress.tokens')}` : ''].filter(Boolean).join(' · ');
  return (
    <aside className="progress-rail">
      <div className="rail-card">
        <div className="rail-task">
          <span className={`rail-status ${chat.running ? 'running' : finished ? 'done' : ''}`}>
            {chat.running ? <LoaderCircle size={20} className="spin" /> : finished ? <CircleCheck size={20} /> : <Circle size={20} />}
          </span>
          <div className="rail-task-text">
            <div className="rail-title">{session?.title ?? ''}</div>
            {meta && <div className="rail-meta">{meta}</div>}
          </div>
        </div>
        {todos.length > 0 && (
          <div className="rail-progress">
            <div className="rail-label">{t('progress.title')}</div>
            <TodoList todos={todos} live={chat.running} />
          </div>
        )}
      </div>
    </aside>
  );
});

const NATIVE_ANCHOR = typeof CSS !== 'undefined' && Boolean(CSS.supports?.('overflow-anchor', 'auto'));

/**
 * The turn that is streaming right now. It is the only part of the thread that changes while
 * text arrives, so it subscribes to the live state on its own and the rest of the chat view does
 * not re-render on every streaming update.
 */
const LiveTurn = memo(function LiveTurn({ continued }: { continued: boolean }) {
  const { live, tools } = useStore((s) => {
    const c = chatOf(s.currentId);
    return { live: c.live, tools: c.tools };
  });
  return (
    <div className={`assistant-turn live ${continued ? 'continued' : ''}`}>
      {live.map((li, i) => {
        if (li.kind === 'thinking') return <ThinkingBlock key={i} text={li.text} live={i === live.length - 1} />;
        if (li.kind === 'text') return <StreamingMarkdown key={i} text={li.text} />;
        const tl = tools[li.id];
        return tl ? <ToolCard key={li.id} id={li.id} name={tl.name} input={tl.input} live={tl} pending /> : null;
      })}
      {!live.length && <ThinkingBlock text="" live />}
    </div>
  );
});

export function ChatView() {
  const currentId = useStore((s) => s.currentId);
  // everything the view shows except the live stream (see LiveTurn)
  const chat = useStore((s) => {
    const c = chatOf(s.currentId);
    return { messages: c.messages, pendingUser: c.pendingUser, running: c.running, loaded: c.loaded, tools: c.tools, todos: c.todos, subagents: c.subagents, notices: c.notices };
  });
  const permissions = useStore((s) => s.permissions.filter((p) => p.sessionId === s.currentId));
  const clarify = useStore((s) => s.clarify.filter((c) => c.sessionId === s.currentId));
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { items, results } = useMemo(() => buildItems(chat.messages), [chat.messages]);
  const subagents = Object.values(chat.subagents);
  const showRail = chat.todos.length > 0;

  // Pin to the bottom on discrete changes only (chat switch, a new message, a card). While text
  // streams in, native scroll anchoring on the bottom sentinel keeps the view pinned with no
  // forced layout per update; browsers without it fall back to scrolling after every render.
  useLayoutEffect(
    () => {
      const el = scroller.current;
      if (el && stick.current) el.scrollTop = el.scrollHeight;
    },
    NATIVE_ANCHOR ? [currentId, chat.loaded, chat.messages.length, chat.pendingUser, chat.running, permissions.length, clarify.length] : undefined,
  );
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
  const lastAssistantIndex = items.map((x) => x.kind).lastIndexOf('assistant');
  return (
    <div className="chat">
      <ChatHeader sessionId={currentId} />
      <div className={`chat-columns ${showRail ? 'with-rail' : ''}`}>
        <div className="chat-main">
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
                return (
                  <AssistantTurn
                    key={it.ms[0]?.id ?? i}
                    messages={it.ms}
                    results={results}
                    tools={chat.tools}
                    running={chat.running && i === items.length - 1}
                    sessionId={currentId}
                    canUndo={!chat.running && i === lastAssistantIndex}
                  />
                );
              })}
              {chat.pendingUser && <UserMessage message={chat.pendingUser} pending />}
              {!chat.running && !chat.pendingUser && items.at(-1)?.kind === 'user' && (items.at(-1) as { m: Message }).m.meta?.unanswered === 'no_provider' && (
                <ConnectCard sessionId={currentId} />
              )}
              {chat.running && <LiveTurn continued={lastIsAssistant} />}
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
            <div className="scroll-anchor" aria-hidden />
          </div>
          <Composer />
        </div>
        {showRail && <ProgressRail sessionId={currentId} />}
      </div>
    </div>
  );
}
