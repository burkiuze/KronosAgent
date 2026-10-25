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

contextBridge.exposeInMainWorld('kronosDesktop', {
  ...info,
  notify: (title: string, body: string) => ipcRenderer.send('kronos:notify', String(title), String(body)),
  setBadge: (count: number) => ipcRenderer.send('kronos:badge', Number(count) || 0),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('kronos:pick-folder'),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('kronos:open-path', String(path)),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('kronos:reveal', String(path)),
  /** menu / tray / shortcut commands: new-chat, settings[:section], view:<page>, panel:<files|terminal>, stop… */
  onCommand: (cb: (command: string) => void) => {
    const listener = (_e: unknown, command: string) => cb(command);
    ipcRenderer.on('kronos:command', listener);
    return () => void ipcRenderer.removeListener('kronos:command', listener);
  },
  onPrompt: (cb: (prompt: string) => void) => {
    const listener = (_e: unknown, prompt: string) => cb(prompt);
    ipcRenderer.on('kronos:prompt', listener);
    return () => void ipcRenderer.removeListener('kronos:prompt', listener);
  },
  onWorkspace: (cb: (path: string) => void) => {
    const listener = (_e: unknown, path: string) => cb(path);
    ipcRenderer.on('kronos:workspace', listener);
    return () => void ipcRenderer.removeListener('kronos:workspace', listener);
  },
});
