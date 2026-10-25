import { memo, useState, type ReactElement } from 'react';
import {
  Brain,
  Check,
  CircleCheck,
  Circle,
  Undo2,
  ChevronDown,
  ChevronRight,
  CircleX,
  Copy,
  FileCode,
  FilePen,
  FileText,
  FolderTree,
  Globe,
  Image as ImageIcon,
  ListTodo,
  LoaderCircle,
  Network,
  Puzzle,
  Search,
  Send,
  SquareTerminal,
  Users,
  Wrench,
  Clock,
  Sparkles,
} from 'lucide-react';
import type { ImagePart, Message, Part, Todo, ToolMeta } from '../lib/types';
import type { ToolLive } from '../lib/store';
import { renderMarkdown } from '../lib/markdown';
import { toolSummary } from '../lib/format';
import { t } from '../lib/i18n';
import { useConfig } from '../lib/config';
import { undoLast } from '../lib/store';

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});

function toolIcon(name: string) {
  if (name === 'read_file' || name === 'view_image') return FileText;
  if (/write_file|edit_file|multi_edit|apply_patch|fs/.test(name)) return FilePen;
  if (name === 'list_dir' || name === 'glob') return FolderTree;
  if (name === 'grep' || name === 'session_search') return Search;
  if (name === 'shell' || name === 'process') return SquareTerminal;
  if (name === 'execute_code') return FileCode;
  if (/web_|browser|http_request/.test(name)) return Globe;
  if (name === 'memory') return Brain;
  if (name === 'todo_write') return ListTodo;
  if (name === 'delegate') return Users;
  if (/skill/.test(name)) return Puzzle;
  if (/cron/.test(name)) return Clock;
  if (name === 'generate_image') return ImageIcon;
  if (name === 'send_message') return Send;
  if (name.startsWith('mcp__')) return Network;
  return Wrench;
}

export function Images({ images }: { images: ImagePart[] }) {
  const [zoom, setZoom] = useState<string | null>(null);
  return (
    <>
      <div className="images">
        {images.map((img, i) => {
          const src = `data:${img.mediaType};base64,${img.data}`;
          return <img key={i} src={src} alt={img.name ?? 'image'} onClick={() => setZoom(src)} />;
        })}
      </div>
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" />
        </div>
      )}
    </>
  );
}

export function Diff({ diff }: { diff: string }) {
  const lines = diff.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todo-list">
      {todos.map((td) => (
        <li key={td.id} className={td.status}>
          <span className="todo-box">
            {td.status === 'completed' ? <CircleCheck size={18} /> : td.status === 'in_progress' ? <LoaderCircle size={18} className="spin" /> : <Circle size={18} />}
          </span>
          <span className="todo-text">{td.status === 'in_progress' ? (td.activeForm ?? td.content) : td.content}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// "N files changed" summary for a turn

interface FileChange {
  path: string;
  added: number;
  removed: number;
  diff: string;
}

/** Split the unified diffs produced by the file tools into per-file stats. */
export function collectChanges(diffs: string[]): FileChange[] {
  const map = new Map<string, FileChange>();
  for (const diff of diffs) {
    let cur: FileChange | undefined;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) {
        const path = line.slice(4).replace(/^b\//, '').trim();
        cur = map.get(path) ?? { path, added: 0, removed: 0, diff: '' };
        map.set(path, cur);
        continue;
      }
      if (line.startsWith('--- ')) continue;
      if (!cur) continue;
      cur.diff += `${line}\n`;
      if (line.startsWith('+')) cur.added += 1;
      else if (line.startsWith('-')) cur.removed += 1;
    }
  }
  return [...map.values()].filter((c) => c.path && c.path !== '/dev/null');
}

const EXT_COLORS: Record<string, string> = {
  js: '#e8c547', mjs: '#e8c547', cjs: '#e8c547', jsx: '#5ccfe6', ts: '#3b82f6', tsx: '#5ccfe6', html: '#e8613c', css: '#8b5cf6', scss: '#d6619b',
  json: '#d4a72c', md: '#9ca3af', py: '#4b8bbe', go: '#22b8cf', rs: '#d97a4a', rb: '#e0474c', java: '#e76f00', sh: '#7ac46e', yml: '#c678dd', yaml: '#c678dd',
  sql: '#e5a00d', vue: '#41b883', svelte: '#ff3e00', php: '#7a86b8', swift: '#f05138', kt: '#a97bff', c: '#5c8dbc', cpp: '#5c8dbc', h: '#5c8dbc',
};

function FileBadge({ path }: { path: string }) {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  const color = EXT_COLORS[ext] ?? 'var(--faint)';
  return (
    <span className="file-badge" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
      {ext.slice(0, 2).toUpperCase() || '·'}
    </span>
  );
}

export function FilesChanged({ changes, sessionId, canUndo }: { changes: FileChange[]; sessionId?: string; canUndo?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!changes.length) return null;
  const added = changes.reduce((a, c) => a + c.added, 0);
  const removed = changes.reduce((a, c) => a + c.removed, 0);
  return (
    <div className="files-changed">
      <div className="fc-head">
        <span className="fc-title">{changes.length === 1 ? t('changes.file') : t('changes.files', { n: changes.length })}</span>
        <span className="add">+{added}</span>
        <span className="del">-{removed}</span>
        <div className="flex-1" />
        {canUndo && sessionId && (
          <button className="fc-undo" onClick={() => void undoLast(sessionId)}>
            {t('changes.undo')} <Undo2 size={14} />
          </button>
        )}
      </div>
      {changes.map((c) => (
        <div key={c.path} className="fc-file">
          <button className="fc-row" onClick={() => setOpen((o) => (o === c.path ? null : c.path))} title={c.path}>
            <FileBadge path={c.path} />
            <span className="fc-name">
              {c.path.split('/').pop()}
              {c.path.includes('/') && <span className="fc-dir">{c.path.slice(0, c.path.lastIndexOf('/'))}</span>}
            </span>
            <span className="add">+{c.added}</span>
            <span className="del">-{c.removed}</span>
          </button>
          {open === c.path && <Diff diff={c.diff} />}
        </div>
      ))}
    </div>
  );
}

export function ThinkingBlock({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim() && !live) return null;
  return (
    <div className={`thinking ${live ? 'live' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen((o) => !o)}>
        <span className={live ? 'shimmer' : ''}>{t('chat.thinking')}</span>
        {text.trim() && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
      </button>
      {open && text.trim() && <div className="thinking-body">{text}</div>}
    </div>
  );
}

interface ToolCardProps {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  live?: ToolLive;
  result?: { content: string; isError?: boolean; durationMs?: number; meta?: ToolMeta; images?: ImagePart[] };
  pending?: boolean;
}

export function ToolCard({ name, input, live, result, pending }: ToolCardProps) {
  const { config } = useConfig();
  const technical = config?.ui?.toolDisplay === 'technical';
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(name);
  const summary = live?.summary ?? toolSummary(name, input ?? live?.input ?? {});
  const res = result ?? live?.result;
  const running = !res && pending;
  const isError = Boolean(res?.isError);
  const meta = res?.meta;
  const todos = (meta?.todos as Todo[] | undefined) ?? (name === 'todo_write' ? ((input?.todos as Todo[] | undefined) ?? undefined) : undefined);
  const diff = meta?.diff as string | undefined;
  const added = meta?.added as number | undefined;
  const removed = meta?.removed as number | undefined;
  const showBody = open || technical;
  return (
    <div className={`tool-card ${isError ? 'error' : ''} ${running ? 'running' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <Icon size={14} className="tool-icon" />
        <span className="tool-summary">{summary}</span>
        {diff && (added !== undefined || removed !== undefined) && (
          <span className="diffstat">
            <span className="add">+{added ?? 0}</span> <span className="del">−{removed ?? 0}</span>
          </span>
        )}
        {running && <LoaderCircle size={13} className="spin muted" />}
        {isError && <CircleX size={13} className="danger" />}
        {res?.durationMs !== undefined && res.durationMs > 1500 && <span className="tool-time">{(res.durationMs / 1000).toFixed(1)}s</span>}
        {(res || input) && <span className="chev">{showBody ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>}
      </button>
      {running && live?.progress && <pre className="tool-progress">{live.progress.split('\n').slice(-6).join('\n')}</pre>}
      {todos && todos.length > 0 && !showBody && <TodoList todos={todos} />}
      {res?.images && res.images.length > 0 && <Images images={res.images} />}
      {showBody && (
        <div className="tool-body">
          {(technical || open) && input && Object.keys(input).length > 0 && (
            <div className="tool-section">
              <div className="tool-label">Input</div>
              <pre>{JSON.stringify(input, null, 2)}</pre>
            </div>
          )}
          {diff && <Diff diff={diff} />}
          {res && !diff && (
            <div className="tool-section">
              <div className="tool-label">{isError ? 'Error' : 'Output'}</div>
              <pre className={isError ? 'danger' : ''}>{res.content.length > 20000 ? `${res.content.slice(0, 20000)}\n…` : res.content}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn tiny"
      title={t('common.copy')}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

export function UserMessage({ message, pending }: { message: Message; pending?: boolean }) {
  const text = message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
  const images = message.parts.filter((p): p is ImagePart => p.type === 'image');
  const files = message.parts.filter((p) => p.type === 'file') as Extract<Part, { type: 'file' }>[];
  // skill invocations are stored with the full skill body: show the request only
  const skill = /^<skill name="([^"]+)">[\s\S]*<\/skill>\s*([\s\S]*)$/.exec(text);
  const shown = skill ? (skill[2] ?? '').replace(/^Use the skill above for this request[:.]?\s*/, '') : text.replace(/<session-context>[\s\S]*?<\/session-context>\s*/, '').replace(/<user_shell_command>[\s\S]*?<\/user_shell_command>\s*/g, '');
  return (
    <div className={`user-msg ${pending ? 'pending' : ''}`}>
      {skill && (
        <span className="skill-chip">
          <Sparkles size={11} /> /{skill[1]}
        </span>
      )}
      <div className="user-text">{shown}</div>
      {files.length > 0 && (
        <div className="attachments">
          {files.map((f, i) => (
            <span key={i} className="attachment">
              <FileText size={12} /> {f.name}
            </span>
          ))}
        </div>
      )}
      {images.length > 0 && <Images images={images} />}
    </div>
  );
}

/** Assistant turn: interleaved thinking, text and tool calls across loop iterations. */
export function AssistantTurn({
  messages,
  results,
  tools,
  running,
  sessionId,
  canUndo,
}: {
  messages: Message[];
  results: Map<string, Extract<Part, { type: 'tool_result' }>>;
  tools: Record<string, ToolLive>;
  running: boolean;
  sessionId?: string;
  canUndo?: boolean;
}) {
  const blocks: ReactElement[] = [];
  const diffs: string[] = [];
  let textForCopy = '';
  messages.forEach((m, mi) => {
    m.parts.forEach((p, pi) => {
      const key = `${m.id}-${pi}`;
      if (p.type === 'thinking' && p.text) blocks.push(<ThinkingBlock key={key} text={p.text} />);
      else if (p.type === 'text' && p.text.trim()) {
        textForCopy += `${p.text}\n\n`;
        blocks.push(<Markdown key={key} text={p.text} />);
      } else if (p.type === 'tool_call') {
        const r = results.get(p.id);
        if (r && !r.isError && typeof r.meta?.diff === 'string') diffs.push(r.meta.diff);
        blocks.push(<ToolCard key={key} id={p.id} name={p.name} input={p.input} live={tools[p.id]} result={r ? { content: r.content, isError: r.isError, meta: r.meta, images: r.images, durationMs: r.meta?.durationMs } : undefined} pending={running && !r} />);
      }
    });
    if (m.meta?.interrupted && mi === messages.length - 1) blocks.push(<div key={`${m.id}-int`} className="notice warn">⏹ interrupted</div>);
  });
  if (!blocks.length) return null;
  return (
    <div className="assistant-turn">
      {blocks}
      {!running && diffs.length > 0 && <FilesChanged changes={collectChanges(diffs)} sessionId={sessionId} canUndo={canUndo} />}
      {textForCopy && !running && (
        <div className="turn-actions">
          <CopyButton text={textForCopy.trim()} />
        </div>
      )}
    </div>
  );
}
