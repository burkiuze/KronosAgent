/**
 * Bridge between the sandboxed UI and the native shell. Everything here is exposed to the web
 * app as `window.kronosDesktop`; the UI feature-detects it and works the same in a browser.
 */
import { contextBridge, ipcRenderer } from 'electron';

interface Info {
  token: string;
  baseUrl: string;
  version: string;
  platform: string;
  attached: boolean;
}

const info = ipcRenderer.sendSync('kronos:info') as Info;

/**
 * A main → UI message channel. Messages that arrive before the UI subscribes (a tray command
 * that had to rebuild a released window, say) are kept and handed to the first subscriber.
 */
function channel(name: string) {
  const early: string[] = [];
  let subscribers = 0;
  ipcRenderer.on(name, (_e, value: string) => {
    if (!subscribers) early.push(value);
  });
  return (cb: (value: string) => void) => {
    const listener = (_e: unknown, value: string) => cb(value);
    ipcRenderer.on(name, listener);
    subscribers++;
    for (const value of early.splice(0)) cb(value);
    return () => {
      subscribers--;
      ipcRenderer.removeListener(name, listener);
    };
  };
}

contextBridge.exposeInMainWorld('kronosDesktop', {
  ...info,
  notify: (title: string, body: string) => ipcRenderer.send('kronos:notify', String(title), String(body)),
  setBadge: (count: number) => ipcRenderer.send('kronos:badge', Number(count) || 0),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('kronos:pick-folder'),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('kronos:open-path', String(path)),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('kronos:reveal', String(path)),
  /** menu / tray / shortcut commands: new-chat, settings[:section], view:<page>, panel:<files|terminal>, stop… */
  onCommand: channel('kronos:command'),
  onPrompt: channel('kronos:prompt'),
  onWorkspace: channel('kronos:workspace'),
});
