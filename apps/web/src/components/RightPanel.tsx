import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Download, Eye, File, Files, Folder, GitBranch, Maximize2, Minimize2, Pencil, RefreshCw, Save, SquareTerminal, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fileUrl, get, put, wsUrl } from '../lib/api';
import { savePref, setState, toast, useStore } from '../lib/store';
import { bytes } from '../lib/format';
import { highlightCode, langFromPath, renderMarkdown } from '../lib/markdown';

interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

function FilesPanel({ root }: { root: string }) {
  const [dir, setDir] = useState(root);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [file, setFile] = useState<{ path: string; content?: string; binary?: boolean; mime?: string; size?: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [hidden, setHidden] = useState(false);

  const load = async (path: string) => {
    try {
      const r = await get<{ path: string; parent: string | null; entries: Entry[] }>(`/api/files?path=${encodeURIComponent(path)}${hidden ? '&hidden=1' : ''}`);
      setDir(r.path);
      setParent(r.parent);
      setEntries(r.entries);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  useEffect(() => {
    void load(root);
  }, [root, hidden]);

  const open = async (e: Entry) => {
    if (e.dir) return load(e.path);
    const r = await get<{ path: string; content?: string; binary?: boolean; mime?: string; size?: number }>(`/api/files/read?path=${encodeURIComponent(e.path)}`);
    setFile(r);
    setEditing(false);
  };

  if (file) {
    const isImage = /^image\//.test(file.mime ?? '');
    const isMd = /\.md$/i.test(file.path);
    return (
      <div className="files">
        <div className="files-bar">
          <button className="icon-btn" onClick={() => setFile(null)} title="Back">
            <ArrowLeft size={15} />
          </button>
          <span className="files-path" title={file.path}>
            {file.path.split(/[\\/]/).pop()}
          </span>
          {!file.binary && !isImage && (
            <button
              className={`icon-btn ${editing ? 'active' : ''}`}
              title={editing ? 'Preview' : 'Edit'}
              onClick={() => {
                setDraft(file.content ?? '');
                setEditing((v) => !v);
              }}
            >
              {editing ? <Eye size={15} /> : <Pencil size={15} />}
            </button>
          )}
          {editing && (
            <button
              className="icon-btn"
              title="Save"
              onClick={async () => {
                await put('/api/files/write', { path: file.path, content: draft });
                setFile({ ...file, content: draft });
                setEditing(false);
                toast('Saved');
              }}
            >
              <Save size={15} />
            </button>
          )}
          <a className="icon-btn" href={fileUrl(file.path, { download: true })} title="Download">
            <Download size={15} />
          </a>
        </div>
        <div className="file-view">
          {isImage ? (
            <img src={fileUrl(file.path)} alt="" className="file-image" />
          ) : file.binary ? (
            <div className="muted pad">Binary file · {bytes(file.size ?? 0)}</div>
          ) : editing ? (
            <textarea className="file-editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          ) : isMd ? (
            <div className="md pad" dangerouslySetInnerHTML={{ __html: renderMarkdown(file.content ?? '') }} />
          ) : (
            <pre className="file-code">
              <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(file.content ?? '', langFromPath(file.path)) }} />
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="files">
      <div className="files-bar">
        <button className="icon-btn" disabled={!parent} onClick={() => parent && void load(parent)} title="Up">
          <ArrowUp size={15} />
        </button>
        <span className="files-path" title={dir}>
          {dir.replace(/^\/home\/[^/]+|^\/Users\/[^/]+/, '~')}
        </span>
        <button className={`icon-btn ${hidden ? 'active' : ''}`} title="Show hidden files" onClick={() => setHidden((h) => !h)}>
          <Eye size={15} />
        </button>
        <button className="icon-btn" title="Refresh" onClick={() => void load(dir)}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="file-list">
        {entries.map((e) => (
          <button key={e.path} className="file-row" onClick={() => void open(e)}>
            {e.dir ? <Folder size={14} className="accent" /> : <File size={14} className="muted" />}
            <span className="file-name">{e.name}</span>
            {!e.dir && <span className="file-size">{bytes(e.size)}</span>}
          </button>
        ))}
        {!entries.length && <div className="muted pad">Empty folder</div>}
      </div>
    </div>
  );
}

function TerminalPanel({ cwd }: { cwd: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState(0);
  const [exited, setExited] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    setExited(false);
    const styles = getComputedStyle(document.documentElement);
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: document.documentElement.dataset.mode === 'dark' ? styles.getPropertyValue('--code').trim() || '#111' : '#0f2a2e',
        foreground: '#e6edf3',
        cursor: styles.getPropertyValue('--accent').trim() || '#d9a441',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    const ws = new WebSocket(wsUrl('/ws/terminal', { cwd, cols: String(term.cols), rows: String(term.rows) }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type: string; data?: string };
      if (msg.type === 'output' && msg.data) term.write(msg.data);
      if (msg.type === 'exit') {
        term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
        setExited(true);
      }
    };
    const sub = term.onData((data) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'input', data })));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch {
        /* not visible */
      }
    });
    ro.observe(host.current);
    term.focus();
    return () => {
      ro.disconnect();
      sub.dispose();
      ws.close();
      term.dispose();
    };
  }, [cwd, key]);
  return (
    <div className="terminal">
      <div className="terminal-head">
        <span className="term-square" /> ZSH
        <div className="flex-1" />
        {exited && (
          <button className="icon-btn tiny" title="Restart" onClick={() => setKey((k) => k + 1)}>
            <RefreshCw size={12} />
          </button>
        )}
      </div>
      <div className="terminal-host" ref={host} />
    </div>
  );
}

export function RightPanel() {
  const panel = useStore((s) => s.rightPanel);
  const currentId = useStore((s) => s.currentId);
  const sessions = useStore((s) => s.sessions);
  const status = useStore((s) => s.status);
  const cwd = sessions.find((s) => s.id === currentId)?.cwd ?? status?.cwd ?? '';
  const [branch, setBranch] = useState<string | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (!cwd) return;
    void get<{ branch: string | null }>(`/api/git?path=${encodeURIComponent(cwd)}`)
      .then((r) => setBranch(r.branch))
      .catch(() => setBranch(null));
  }, [cwd]);
  const set = (p: 'files' | 'terminal' | null) => {
    savePref('rightPanel', p);
    setState({ rightPanel: p });
  };
  return (
    <aside className={`right-panel ${wide ? 'wide' : ''}`}>
      <div className="right-tabs">
        <button className={`icon-btn ${panel === 'files' ? 'active' : ''}`} title="Files" onClick={() => set('files')}>
          <Files size={15} />
        </button>
        <button className={`icon-btn ${panel === 'terminal' ? 'active' : ''}`} title="Terminal" onClick={() => set('terminal')}>
          <SquareTerminal size={15} />
        </button>
        <div className="flex-1" />
        {branch && (
          <span className="branch">
            <GitBranch size={12} /> {branch}
          </span>
        )}
        <button className="icon-btn" title={wide ? 'Narrow' : 'Widen'} onClick={() => setWide((w) => !w)}>
          {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button className="icon-btn" title="Close" onClick={() => set(null)}>
          <X size={14} />
        </button>
      </div>
      <div className="right-body">{panel === 'terminal' ? <TerminalPanel cwd={cwd} /> : <FilesPanel root={cwd} />}</div>
    </aside>
  );
}
