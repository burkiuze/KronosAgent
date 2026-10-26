import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Brain, Check, ChevronDown, FilePen, FileText, Folder, FolderGit2, Hand, ListChecks, Mic, MicOff, Paperclip, Plus, Square, X, Zap, type LucideIcon } from 'lucide-react';
import { get, api } from '../lib/api';
import { chatOf, getState, loadSession, newChat, sendMessage, undoLast, setSessionMode, setState, stopRun, toast, useStore } from '../lib/store';
import { updateConfig, useConfig } from '../lib/config';
import { VoiceInput } from '../lib/voice';
import { t } from '../lib/i18n';
import type { FilePart, ImagePart, ModelInfo, PermissionMode } from '../lib/types';
import { ModelPicker } from './ModelPicker';
import { EffortMenu, type EffortLevel } from './EffortMenu';
import { ProviderLogo } from './ProviderConnect';
import { Menu, MenuItem } from './ui';

interface Command {
  name: string;
  description: string;
  source: string;
}

const MODE_IDS: PermissionMode[] = ['ask', 'auto-edit', 'yolo', 'plan'];
const MODE_ICONS: Record<PermissionMode, LucideIcon> = { ask: Hand, 'auto-edit': FilePen, yolo: Zap, plan: ListChecks };
const modeLabel = (m: PermissionMode) => ({ id: m, label: t(`mode.${m}`), hint: t(`mode.${m}.hint`), Icon: MODE_ICONS[m] });

// friendly model names for the composer (fetched once)
let modelNames: Record<string, string> | null = null;
let modelNamesLoading: Promise<void> | null = null;
function useModelName(ref: string | undefined, fallback?: string): string {
  const [, force] = useState(0);
  useEffect(() => {
    if (modelNames || modelNamesLoading) return;
    modelNamesLoading = get<{ models: ModelInfo[] }>('/api/models')
      .then((r) => {
        modelNames = Object.fromEntries(r.models.map((m) => [m.ref, m.name]));
        force((n) => n + 1);
      })
      .catch(() => undefined);
  }, []);
  if (!ref) return fallback ?? 'model';
  return modelNames?.[ref] ?? fallback ?? (ref.split(':').slice(1).join(':') || ref);
}

/** Small circular gauge for how full the context window is. */
function ContextRing({ percent }: { percent: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  return (
    <span className={`ctx-ring ${p >= 80 ? 'hot' : ''}`} title={t('composer.ctxTitle', { p })}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} className="ctx-track" />
        <circle cx="9" cy="9" r={r} className="ctx-fill" strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 9 9)" />
      </svg>
    </span>
  );
}

const TEXT_EXT = /\.(txt|md|markdown|json|ya?ml|toml|ini|csv|tsv|log|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|bash|zsh|sql|lua|r|dart|vue|svelte|env|conf|cfg)$/i;

async function fileToPart(f: File): Promise<ImagePart | FilePart> {
  if (f.type.startsWith('image/')) {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { type: 'image', mediaType: f.type, data: btoa(bin), name: f.name };
  }
  if ((f.type.startsWith('text/') || TEXT_EXT.test(f.name) || f.type.includes('json')) && f.size < 400_000) {
    return { type: 'file', name: f.name, mediaType: f.type || 'text/plain', text: await f.text(), size: f.size };
  }
  const res = await api<{ path: string }>(`/api/files/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, headers: { 'content-type': 'application/octet-stream' } });
  return { type: 'file', name: f.name, mediaType: f.type || 'application/octet-stream', path: res.path, size: f.size, text: `(uploaded to ${res.path} — use tools to read it)` };
}

// memoized: the chat view re-renders on every streaming flush, the composer has no reason to
export const Composer = memo(function Composer({ centered }: { centered?: boolean }) {
  const currentId = useStore((s) => s.currentId);
  // only the fields the composer shows: streaming text changes the chat many times a second
  const chat = useStore((s) => {
    const c = chatOf(s.currentId);
    return { running: c.running, queue: c.queue, context: c.context };
  });
  const sessions = useStore((s) => s.sessions);
  const draftMode = useStore((s) => s.draftMode);
  const status = useStore((s) => s.status);
  const session = sessions.find((s) => s.id === currentId);
  const { config } = useConfig();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<(ImagePart | FilePart)[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [files, setFiles] = useState<{ name: string; dir: boolean }[]>([]);
  const [listening, setListening] = useState(false);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const voice = useRef<VoiceInput | undefined>(undefined);
  const baseText = useRef('');
  const mode: PermissionMode = session?.mode ?? draftMode ?? (config?.safety?.mode as PermissionMode) ?? 'ask';
  const running = chat.running;

  useEffect(() => {
    ref.current?.focus();
  }, [currentId]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);

  // slash command menu
  const slash = /^\/([\w.-]*)$/.exec(text);
  useEffect(() => {
    if (slash && !commands.length) void get<Command[]>('/api/commands').then(setCommands).catch(() => undefined);
  }, [Boolean(slash)]);
  const builtin: Command[] = [
    { name: 'new', description: 'Start a new conversation', source: 'builtin' },
    { name: 'undo', description: 'Undo the last turn', source: 'builtin' },
    { name: 'compact', description: 'Compress the conversation', source: 'builtin' },
    { name: 'plan', description: 'Switch to plan mode', source: 'builtin' },
    { name: 'yolo', description: 'Toggle yolo mode', source: 'builtin' },
  ];
  const slashItems = useMemo(() => {
    if (!slash) return [];
    const q = (slash[1] ?? '').toLowerCase();
    return [...builtin, ...commands].filter((c) => c.name.toLowerCase().includes(q)).slice(0, 10);
  }, [slash?.[1], commands]);

  // @file mentions
  const mention = /(?:^|\s)@([^\s]*)$/.exec(text);
  useEffect(() => {
    if (!mention) return;
    const partial = mention[1] ?? '';
    const dir = partial.includes('/') ? partial.slice(0, partial.lastIndexOf('/') + 1) : '';
    const cwd = session?.cwd ?? status?.cwd ?? '';
    void get<{ entries: { name: string; dir: boolean }[] }>(`/api/files?path=${encodeURIComponent(`${cwd}/${dir}`)}`)
      .then((r) => setFiles(r.entries.filter((e) => e.name.toLowerCase().startsWith(partial.slice(dir.length).toLowerCase())).slice(0, 10).map((e) => ({ ...e, name: dir + e.name }))))
      .catch(() => setFiles([]));
  }, [mention?.[1]]);
  const mentionItems = mention ? files : [];

  const menuItems = slashItems.length ? slashItems.map((c) => ({ key: c.name, label: `/${c.name}`, desc: c.description })) : mentionItems.map((f) => ({ key: f.name, label: `@${f.name}${f.dir ? '/' : ''}`, desc: f.dir ? 'folder' : 'file' }));

  const applyMenu = (i: number) => {
    if (slashItems.length) {
      const c = slashItems[i];
      if (c) setText(`/${c.name} `);
    } else if (mentionItems.length) {
      const f = mentionItems[i];
      if (f) setText(text.replace(/@([^\s]*)$/, `@${f.name}${f.dir ? '/' : ' '}`));
    }
    setMenuIndex(0);
  };

  const submit = async () => {
    const value = text.trim();
    if (!value && !attachments.length) return;
    const id = getState().currentId;
    // client-side commands
    if (value === '/new') {
      setText('');
      newChat();
      return;
    }
    if (value === '/plan' || value === '/yolo') {
      const next: PermissionMode = value === '/plan' ? 'plan' : mode === 'yolo' ? 'ask' : 'yolo';
      if (id) await setSessionMode(id, next);
      else setState({ draftMode: next });
      toast(`Mode → ${next}`, 'info');
      setText('');
      return;
    }
    if (id && (value === '/undo' || value === '/compact')) {
      setText('');
      if (value === '/undo') await undoLast(id);
      else {
        toast('Compacting…', 'info');
        await api(`/api/sessions/${id}/compact`, { method: 'POST' });
        await loadSession(id);
      }
      return;
    }
    const images = attachments.filter((a): a is ImagePart => a.type === 'image');
    const filesAtt = attachments.filter((a): a is FilePart => a.type === 'file');
    setText('');
    setAttachments([]);
    await sendMessage(value || '(see attachments)', { images, files: filesAtt });
  };

  const addFiles = async (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      try {
        const part = await fileToPart(f);
        setAttachments((a) => [...a, part]);
      } catch (e) {
        toast(`Could not attach ${f.name}: ${(e as Error).message}`, 'error');
      }
    }
  };

  const toggleVoice = () => {
    if (!voice.current) {
      voice.current = new VoiceInput(
        (t2, final) => {
          setText(`${baseText.current}${baseText.current && !baseText.current.endsWith(' ') ? ' ' : ''}${t2}`);
          if (final && !(window as unknown as Record<string, unknown>).webkitSpeechRecognition && !(window as unknown as Record<string, unknown>).SpeechRecognition) baseText.current = '';
        },
        setListening,
        (msg) => toast(msg, 'error'),
      );
    }
    if (listening) voice.current.stop();
    else {
      baseText.current = text;
      void voice.current.start();
    }
  };

  const sendOnEnter = config?.ui?.sendOnEnter !== false;
  const placeholder = currentId ? t('composer.followup') : centered ? t('composer.welcome') : t('chat.placeholder');
  const modeInfo = modeLabel(MODE_IDS.includes(mode) ? mode : 'ask');
  const modelRef = session?.model || getState().draftModel || status?.model?.ref;
  const modelName = useModelName(modelRef, modelRef === status?.model?.ref ? status?.model?.name : undefined);
  const effort = (config?.model?.effort as EffortLevel | undefined) ?? 'medium';
  const needsProvider = Boolean(status?.needsProvider);

  const modeOptions = (close: () => void) =>
    MODE_IDS.map(modeLabel).map((m) => (
      <button
        key={m.id}
        className={`mode-option ${m.id === mode ? 'selected' : ''}`}
        onClick={() => {
          close();
          if (currentId) void setSessionMode(currentId, m.id);
          else setState({ draftMode: m.id });
        }}
      >
        <m.Icon size={16} />
        <span className="mode-text">
          <b>{m.label}</b>
          <small>{m.hint}</small>
        </span>
        {m.id === mode && <Check size={14} />}
      </button>
    ));

  const effortMenu = (
    <Menu
      up={!centered}
      align={centered ? 'right' : 'left'}
      trigger={(open) =>
        centered ? (
          <button className={`cbtn me-effort ${effort === 'codemaster' ? 'codemaster' : ''}`} onClick={open} title={t('effort.label')}>
            <span className="cbtn-label">{t(`effort.${effort}`)}</span>
            <ChevronDown size={13} className="cbtn-chev" />
          </button>
        ) : (
          <button className={`cbtn ${effort === 'codemaster' ? 'codemaster' : ''}`} onClick={open} title={t('effort.label')}>
            <Brain size={16} />
            <span className="cbtn-label">{t(`effort.${effort}`)}</span>
          </button>
        )
      }
    >
      {(close) => (
        <EffortMenu
          value={effort}
          onPick={(ef) => {
            // Codemaster stays open so its banner can play; other levels close right away
            if (ef !== 'codemaster') close();
            void updateConfig({ model: { effort: ef } });
          }}
        />
      )}
    </Menu>
  );

  return (
    <div
      className={`composer-wrap ${centered ? 'centered' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      {chat.queue.length > 0 && (
        <div className="queue">
          {chat.queue.map((q) => (
            <span key={q.id} className="queue-chip" title={q.text}>
              {t('chat.queued')}: {q.text.slice(0, 60)}
            </span>
          ))}
        </div>
      )}
      {menuItems.length > 0 && (
        <div className="composer-menu">
          {menuItems.map((m, i) => (
            <button key={m.key} className={`composer-menu-item ${i === menuIndex ? 'active' : ''}`} onMouseDown={(e) => (e.preventDefault(), applyMenu(i))}>
              <span className="cm-label">{m.label}</span>
              <span className="cm-desc">{m.desc}</span>
            </button>
          ))}
        </div>
      )}
      <div className={`composer ${dragging ? 'dragging' : ''} ${listening ? 'listening' : ''}`}>
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((a, i) => (
              <span key={i} className="attachment">
                {a.type === 'image' ? <img src={`data:${a.mediaType};base64,${a.data}`} alt="" /> : <FileText size={12} />}
                {a.name}
                <button className="icon-btn tiny" onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setMenuIndex(0);
          }}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
            if (imgs.length) {
              e.preventDefault();
              void addFiles(imgs);
            }
          }}
          onKeyDown={(e) => {
            if (menuItems.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMenuIndex((i) => (i + 1) % menuItems.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMenuIndex((i) => (i - 1 + menuItems.length) % menuItems.length);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && mentionItems.length)) {
                e.preventDefault();
                applyMenu(menuIndex);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && (sendOnEnter || e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
            if (e.key === 'Escape' && running && currentId) stopRun(currentId);
          }}
        />
        <div className="composer-bar">
          <Menu
            up={!centered}
            trigger={(open) => (
              <button className="cbtn icon" title={t('composer.attach')} onClick={open}>
                <Plus size={18} />
              </button>
            )}
          >
            {(close) => (
              <div className={centered ? 'plus-menu' : undefined}>
                <MenuItem icon={<Paperclip size={14} />} onClick={() => (close(), fileInput.current?.click())}>
                  {t('composer.attach')}
                </MenuItem>
                <MenuItem icon={<Folder size={14} />} onClick={() => (close(), setText((x) => `${x}@`), ref.current?.focus())}>
                  {t('composer.mention')}
                </MenuItem>
                <MenuItem icon={<Zap size={14} />} onClick={() => (close(), setText('/'), ref.current?.focus())}>
                  {t('composer.command')}
                </MenuItem>
                <MenuItem icon={<FolderGit2 size={14} />} onClick={() => (close(), setState({ repoPicker: true }))}>
                  {t('composer.github')}
                </MenuItem>
                {centered && (
                  <>
                    {/* the welcome composer keeps its bar minimal, so permissions live here */}
                    <div className="menu-sep" />
                    <div className="menu-title">{t('composer.permissions')}</div>
                    {modeOptions(close)}
                  </>
                )}
              </div>
            )}
          </Menu>
          {!centered && (
            <>
              <Menu
                up
                trigger={(open) => (
                  <button className={`cbtn mode-${mode}`} onClick={open} title={modeInfo.hint}>
                    <modeInfo.Icon size={16} />
                    <span className="cbtn-label">{modeInfo.label}</span>
                    <ChevronDown size={13} className="cbtn-chev" />
                  </button>
                )}
              >
                {(close) => <div className="mode-menu">{modeOptions(close)}</div>}
              </Menu>
              <ContextRing percent={chat.context?.percent ?? 0} />
              {needsProvider ? (
                <button className="cbtn connect-chip" onClick={() => setState({ settings: 'keys' })}>
                  <span className="cbtn-label">{t('connect.chip')}</span>
                </button>
              ) : (
                <ModelPicker>
                  <span className="cbtn" title={modelRef}>
                    {modelRef && !modelRef.startsWith('kronos:') && <ProviderLogo id={modelRef.split(':')[0] ?? ''} label={modelRef} size={20} />}
                    <span className="cbtn-label">{modelName}</span>
                    <ChevronDown size={13} className="cbtn-chev" />
                  </span>
                </ModelPicker>
              )}
              {effortMenu}
            </>
          )}
          {chat.queue.length > 0 && <span className="cbtn-note">{t('chat.queued')} · {chat.queue.length}</span>}
          <div className="flex-1" />
          {centered && (
            <span className="model-effort">
              {needsProvider ? (
                <button className="cbtn me-model connect-chip" onClick={() => setState({ settings: 'keys' })}>
                  {t('connect.chip')}
                </button>
              ) : (
                <ModelPicker compact down>
                  <span className="cbtn me-model" title={modelRef}>
                    {modelName}
                  </span>
                </ModelPicker>
              )}
              {effortMenu}
            </span>
          )}
          <button className={`cbtn icon ${listening ? 'recording' : ''}`} title="Voice input" onClick={toggleVoice}>
            {listening ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          {running && !text.trim() ? (
            <button className="send-btn stop" title={`${t('chat.stop')} (Esc)`} onClick={() => currentId && stopRun(currentId)}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button className="send-btn" title={t('chat.send')} disabled={!text.trim() && !attachments.length} onClick={() => void submit()}>
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
