import { useEffect } from 'react';
import { PanelLeft, PanelRight, Settings, Volume2, VolumeX } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { ChatView } from './components/ChatView';
import { RightPanel } from './components/RightPanel';
import { SettingsModal } from './components/Settings';
import { CommandPalette } from './components/CommandPalette';
import { Toasts } from './components/Toasts';
import { SkillsPage } from './pages/Skills';
import { ArtifactsPage } from './pages/Artifacts';
import { MessagingPage } from './pages/Messaging';
import { AutomationsPage } from './pages/Automations';
import { MemoryPage } from './pages/Memory';
import { InsightsPage } from './pages/Insights';
import { getState, newChat, onFinalText, savePref, setState, stopRun, useStore, type View } from './lib/store';
import { useConfig } from './lib/config';
import { speak, stopSpeaking } from './lib/voice';
import { useLang } from './lib/i18n';

const isMac = navigator.platform.toLowerCase().includes('mac');

interface DesktopBridge {
  platform?: string;
  onCommand?: (cb: (command: string) => void) => () => void;
}

/** Commands sent by the native menu / tray / global shortcut of the desktop shell. */
function runDesktopCommand(command: string): void {
  const [name, arg] = command.split(':');
  switch (name) {
    case 'new-chat':
      newChat();
      break;
    case 'settings':
      setState({ settings: arg || 'model' });
      break;
    case 'palette':
      setState({ paletteOpen: true });
      break;
    case 'toggle-sidebar':
      setState((s) => (savePref('sidebarOpen', !s.sidebarOpen), { sidebarOpen: !s.sidebarOpen }));
      break;
    case 'panel':
      setState(() => (savePref('rightPanel', arg || null), { rightPanel: (arg as 'files' | 'terminal') || null }));
      break;
    case 'view':
      setState({ view: (arg || 'chat') as View });
      break;
    case 'stop': {
      const id = getState().currentId;
      if (id) stopRun(id);
      break;
    }
    case 'focus-composer':
      (document.querySelector('.composer textarea') as HTMLTextAreaElement | null)?.focus();
      break;
    default:
      break;
  }
}

export function App() {
  useLang();
  const view = useStore((s) => s.view);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const rightPanel = useStore((s) => s.rightPanel);
  const autoSpeak = useStore((s) => s.autoSpeak);
  const { config } = useConfig();
  const desktop = (window as unknown as { kronosDesktop?: DesktopBridge }).kronosDesktop;

  useEffect(() => desktop?.onCommand?.(runDesktopCommand), []);

  useEffect(() => {
    onFinalText((text) => void speak(text, config?.voice?.tts === 'openai' || config?.voice?.tts === 'elevenlabs' ? 'server' : 'browser'));
  }, [config?.voice?.tts]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        setState((s) => ({ paletteOpen: !s.paletteOpen }));
      } else if (k === 'n' && !e.shiftKey) {
        e.preventDefault();
        newChat();
      } else if (k === ',') {
        e.preventDefault();
        setState({ settings: 'model' });
      } else if (k === 'b') {
        e.preventDefault();
        setState((s) => {
          savePref('sidebarOpen', !s.sidebarOpen);
          return { sidebarOpen: !s.sidebarOpen };
        });
      } else if (k === 'j') {
        e.preventDefault();
        setState((s) => {
          const next = s.rightPanel ? null : 'files';
          savePref('rightPanel', next);
          return { rightPanel: next };
        });
      } else if (k === '.') {
        const id = getState().currentId;
        if (id) {
          e.preventDefault();
          stopRun(id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const page = (() => {
    switch (view) {
      case 'skills':
        return <SkillsPage />;
      case 'artifacts':
        return <ArtifactsPage />;
      case 'messaging':
        return <MessagingPage />;
      case 'automations':
        return <AutomationsPage />;
      case 'memory':
        return <MemoryPage />;
      case 'insights':
        return <InsightsPage />;
      default:
        return <ChatView />;
    }
  })();

  return (
    <div className={`app ${sidebarOpen ? '' : 'no-sidebar'} ${rightPanel ? 'with-right' : ''} ${desktop?.platform === 'darwin' ? 'mac-desktop' : ''}`}>
      <div className="wallpaper" />
      <Sidebar />
      <main className="main">
        {!sidebarOpen && (
          <button
            className="icon-btn sidebar-reopen"
            title="Show sidebar (⌘B)"
            onClick={() => {
              savePref('sidebarOpen', true);
              setState({ sidebarOpen: true });
            }}
          >
            <PanelLeft size={16} />
          </button>
        )}
        <div className="global-actions">
          <button
            className={`icon-btn ${autoSpeak ? 'active' : ''}`}
            title={autoSpeak ? 'Auto-speak replies: on' : 'Auto-speak replies: off'}
            onClick={() => {
              const next = !autoSpeak;
              if (!next) stopSpeaking();
              savePref('autoSpeak', next);
              setState({ autoSpeak: next });
            }}
          >
            {autoSpeak ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          {!sidebarOpen && (
            <button className="icon-btn" title="Settings (⌘,)" onClick={() => setState({ settings: 'model' })}>
              <Settings size={16} />
            </button>
          )}
          <button
            className={`icon-btn ${rightPanel ? 'active' : ''}`}
            title="Files & terminal (⌘J)"
            onClick={() =>
              setState((s) => {
                const next = s.rightPanel ? null : 'files';
                savePref('rightPanel', next);
                return { rightPanel: next };
              })
            }
          >
            <PanelRight size={16} />
          </button>
        </div>
        {page}
      </main>
      {rightPanel && <RightPanel />}
      <StatusBar />
      <SettingsModal />
      <CommandPalette />
      <Toasts />
    </div>
  );
}
