/**
 * KRONOS Desktop — the native shell around the Kronos gateway + web UI.
 *
 * It embeds the full agent runtime in the main process (or attaches to a gateway that is already
 * running for this profile), serves the UI over loopback with a per-launch token, and adds what a
 * browser tab can't: a tray icon that keeps messaging platforms and automations alive in the
 * background, a global "summon" shortcut, native notifications, menus, deep links and auto-update.
 */
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Kronos, KRONOS_VERSION, kronosPortrait } from '@kronos/core';
import { Gateway } from '@kronos/gateway';

const isMac = process.platform === 'darwin';
const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '..');
const appDir = app.isPackaged ? join(process.resourcesPath, 'app.asar') : join(__dirname, '..');

// The bundled UI and skills ship next to the main bundle (see build.mjs).
process.env.KRONOS_UI_DIR ??= join(appDir, 'web');
process.env.KRONOS_BUNDLED_SKILLS ??= existsSync(join(resources, 'skills')) ? join(resources, 'skills') : join(appDir, 'skills');

// ---------------------------------------------------------------------------------------------
// desktop preferences (window bounds, tray behaviour, global shortcut)

interface Prefs {
  bounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  closeToTray: boolean;
  shortcut: string;
  openAtLogin: boolean;
}

const prefsFile = () => join(app.getPath('userData'), 'desktop.json');
let prefs: Prefs = { closeToTray: true, shortcut: 'CommandOrControl+Shift+K', openAtLogin: false };

function loadPrefs(): void {
  try {
    prefs = { ...prefs, ...JSON.parse(readFileSync(prefsFile(), 'utf8')) };
  } catch {
    /* first launch */
  }
}

function savePrefs(): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
  } catch {
    /* read-only profile */
  }
}

// ---------------------------------------------------------------------------------------------
// runtime + gateway

interface Backend {
  url: string;
  token: string;
  /** null when attached to an external `kronos gateway` */
  gateway: Gateway | null;
  runtime: Kronos | null;
}

let backend: Backend | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

async function probe(url: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/status`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(800) });
    return res.ok && Boolean(((await res.json()) as { version?: string }).version);
  } catch {
    return false;
  }
}

async function startBackend(): Promise<Backend> {
  const runtime = await Kronos.create({ startCron: false, logLevel: 'warn' });
  const cfg = runtime.config.gateway;
  const port = Number(process.env.KRONOS_PORT ?? cfg.port ?? 7777);

  // A gateway for this profile is already running (e.g. `kronos gateway` as a service):
  // attach to it instead of starting a second set of messaging adapters.
  const existing = `http://127.0.0.1:${port}`;
  if (await probe(existing, cfg.token)) {
    await runtime.close();
    return { url: existing, token: cfg.token, gateway: null, runtime: null };
  }

  const token = cfg.token || randomBytes(24).toString('base64url');
  let gateway: Gateway;
  try {
    gateway = await Gateway.start(runtime, { host: '127.0.0.1', port, token, quiet: true });
  } catch {
    // port taken by something else — any free port works for the desktop window
    gateway = await Gateway.start(runtime, { host: '127.0.0.1', port: 0, token, quiet: true });
  }
  return { url: gateway.url, token, gateway, runtime };
}

// ---------------------------------------------------------------------------------------------
// icons

function appIcon(size = 256): Electron.NativeImage {
  const file = join(resources, 'build', 'icon.png');
  if (existsSync(file)) return nativeImage.createFromPath(file);
  return nativeImage.createFromBuffer(kronosPortrait('Kronos, keeper of time', size));
}

function trayIcon(): Electron.NativeImage {
  const file = join(resources, 'build', isMac ? 'trayTemplate.png' : 'tray.png');
  if (existsSync(file)) return nativeImage.createFromPath(file);
  return appIcon(64).resize({ width: 18, height: 18 });
}

// ---------------------------------------------------------------------------------------------
// window

function send(command: string): void {
  if (!win) createWindow();
  win?.show();
  win?.focus();
  win?.webContents.send('kronos:command', command);
}

function createWindow(): void {
  if (!backend) return;
  const b = prefs.bounds ?? { width: 1360, height: 880 };
  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Kronos',
    icon: appIcon(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121317' : '#f7f5f0',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    autoHideMenuBar: !isMac,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());

  const url = new URL(backend.url);
  url.searchParams.set('token', backend.token);
  void win.loadURL(url.toString());

  // links open in the real browser; the app itself never navigates away
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    // downloads/exports from the gateway and external links both go to the default browser
    if (/^(https?|mailto):/.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(backend!.url)) {
      e.preventDefault();
      void shell.openExternal(target);
    }
  });
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission)));

  const remember = () => {
    if (!win || win.isMinimized()) return;
    prefs.bounds = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    savePrefs();
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', (e) => {
    remember();
    if (!quitting && prefs.closeToTray && backend?.gateway) {
      e.preventDefault();
      win?.hide();
      if (isMac) app.dock?.hide();
    }
  });
  win.on('show', () => isMac && void app.dock?.show());
  win.on('closed', () => (win = null));
}

function toggleWindow(): void {
  if (!win) return createWindow();
  if (win.isVisible() && win.isFocused()) win.hide();
  else {
    win.show();
    win.focus();
    win.webContents.send('kronos:command', 'focus-composer');
  }
}

// ---------------------------------------------------------------------------------------------
// tray + menus

function rebuildTray(): void {
  if (!backend) return;
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip('Kronos');
    tray.on('click', () => !isMac && toggleWindow());
  }
  const embedded = Boolean(backend.gateway);
  const platforms = backend.gateway?.platforms.statuses().filter((p) => p.enabled) ?? [];
  const menu: MenuItemConstructorOptions[] = [
    { label: 'Open Kronos', click: () => send('focus-composer') },
    { label: 'New agent', accelerator: 'CommandOrControl+N', click: () => send('new-chat') },
    { type: 'separator' },
    { label: embedded ? `Gateway · ${backend.url}` : `Attached to ${backend.url}`, enabled: false },
    ...platforms.map((p): MenuItemConstructorOptions => ({ label: `  ${p.label}: ${p.state}`, enabled: false })),
    { label: 'Messaging…', click: () => send('view:messaging') },
    { label: 'Automations…', click: () => send('view:automations') },
    { type: 'separator' },
    { label: 'Keep running in the background', type: 'checkbox', checked: prefs.closeToTray, click: (i) => ((prefs.closeToTray = i.checked), savePrefs()) },
    { label: 'Open at login', type: 'checkbox', checked: prefs.openAtLogin, click: (i) => setOpenAtLogin(i.checked) },
    { type: 'separator' },
    { label: 'Quit Kronos', accelerator: 'CommandOrControl+Q', click: () => quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(menu));
}

function setOpenAtLogin(on: boolean): void {
  prefs.openAtLogin = on;
  savePrefs();
  app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true, args: ['--hidden'] });
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Kronos',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Command+,', click: () => send('settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { label: 'Quit Kronos', accelerator: 'Command+Q', click: () => quit() },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Agent', accelerator: 'CommandOrControl+N', click: () => send('new-chat') },
        { label: 'Command Palette', accelerator: 'CommandOrControl+K', click: () => send('palette') },
        { type: 'separator' },
        {
          label: 'Open Folder as Workspace…',
          accelerator: 'CommandOrControl+O',
          click: async () => {
            const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
            if (!r.canceled && r.filePaths[0]) win?.webContents.send('kronos:workspace', r.filePaths[0]);
          },
        },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: () => send('settings') }, { type: 'separator' as const }]),
        isMac ? { role: 'close' } : { label: 'Quit', accelerator: 'Ctrl+Q', click: () => quit() },
      ] as MenuItemConstructorOptions[],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CommandOrControl+B', click: () => send('toggle-sidebar') },
        { label: 'Files', accelerator: 'CommandOrControl+J', click: () => send('panel:files') },
        { label: 'Terminal', accelerator: 'CommandOrControl+`', click: () => send('panel:terminal') },
        { type: 'separator' },
        { label: 'Skills', click: () => send('view:skills') },
        { label: 'Messaging', click: () => send('view:messaging') },
        { label: 'Artifacts', click: () => send('view:artifacts') },
        { label: 'Automations', click: () => send('view:automations') },
        { label: 'Memory', click: () => send('view:memory') },
        { label: 'Insights', click: () => send('view:insights') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Agent',
      submenu: [
        { label: 'Stop Current Run', accelerator: 'CommandOrControl+.', click: () => send('stop') },
        { label: 'API Keys…', click: () => send('settings:keys') },
        { label: 'Model…', click: () => send('settings:model') },
        { label: 'MCP Servers…', click: () => send('settings:mcp') },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Documentation', click: () => void shell.openExternal('https://github.com/burkiuze/KronosAgent#readme') },
        { label: 'Report an Issue', click: () => void shell.openExternal('https://github.com/burkiuze/KronosAgent/issues') },
        { label: 'Open Kronos Home Folder', click: () => backend?.runtime && void shell.openPath(backend.runtime.paths.root) },
        { label: 'Check for Updates…', click: () => void checkForUpdates(true) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------------------------
// updates

async function checkForUpdates(interactive = false): Promise<void> {
  if (!app.isPackaged) {
    if (interactive) void dialog.showMessageBox({ message: 'Updates are only available in packaged builds.', detail: `Kronos ${KRONOS_VERSION}` });
    return;
  }
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.allowPrerelease = backend?.runtime?.config.updates.channel === 'beta';
    autoUpdater.on('update-downloaded', (info) => {
      new Notification({ title: 'Kronos update ready', body: `Version ${info.version} installs when you quit.` }).show();
    });
    const r = await autoUpdater.checkForUpdates();
    if (interactive && !r?.isUpdateAvailable) void dialog.showMessageBox({ message: 'Kronos is up to date.', detail: `Version ${KRONOS_VERSION}` });
  } catch (e) {
    if (interactive) void dialog.showMessageBox({ type: 'warning', message: 'Update check failed', detail: (e as Error).message });
  }
}

// ---------------------------------------------------------------------------------------------
// ipc (exposed through preload.ts as window.kronosDesktop)

ipcMain.on('kronos:info', (e) => {
  e.returnValue = { token: backend?.token ?? '', baseUrl: backend?.url ?? '', version: KRONOS_VERSION, platform: process.platform, attached: !backend?.gateway };
});
ipcMain.on('kronos:notify', (_e, title: string, body: string) => {
  if (win?.isFocused()) return;
  const n = new Notification({ title, body, icon: appIcon(128) });
  n.on('click', () => (win?.show(), win?.focus()));
  n.show();
});
ipcMain.handle('kronos:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle('kronos:open-path', (_e, path: string) => shell.openPath(path));
ipcMain.handle('kronos:reveal', (_e, path: string) => shell.showItemInFolder(path));
ipcMain.on('kronos:badge', (_e, count: number) => {
  app.setBadgeCount(Math.max(0, count | 0));
});

// ---------------------------------------------------------------------------------------------
// lifecycle

function handleDeepLink(url: string): void {
  // kronos://new?prompt=…  ·  kronos://session/<id>  ·  kronos://settings/keys
  try {
    const u = new URL(url);
    const path = `${u.hostname}${u.pathname}`.replace(/\/$/, '');
    if (path === 'new') send('new-chat');
    else if (path.startsWith('settings')) send(`settings:${path.split('/')[1] ?? 'model'}`);
    else if (path.startsWith('view/')) send(`view:${path.split('/')[1]}`);
    const prompt = u.searchParams.get('prompt');
    if (prompt) win?.webContents.send('kronos:prompt', prompt);
  } catch {
    /* ignore malformed links */
  }
}

async function quit(): Promise<void> {
  quitting = true;
  globalShortcut.unregisterAll();
  try {
    await backend?.gateway?.close();
    await backend?.runtime?.close();
  } catch {
    /* shutting down anyway */
  }
  app.exit(0);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => a.startsWith('kronos://'));
    if (link) handleDeepLink(link);
    else send('focus-composer');
  });
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleDeepLink(url);
  });
  app.setAsDefaultProtocolClient('kronos');
  app.setAboutPanelOptions({ applicationName: 'Kronos', applicationVersion: KRONOS_VERSION, copyright: 'Apache-2.0', website: 'https://github.com/burkiuze/KronosAgent' });

  app.whenReady().then(async () => {
    loadPrefs();
    if (isMac) app.dock?.setIcon(appIcon(512));
    try {
      backend = await startBackend();
    } catch (e) {
      dialog.showErrorBox('Kronos could not start', (e as Error).stack ?? String(e));
      app.exit(1);
      return;
    }
    buildMenu();
    rebuildTray();
    setInterval(rebuildTray, 15_000).unref();
    if (prefs.shortcut) {
      try {
        globalShortcut.register(prefs.shortcut, toggleWindow);
      } catch {
        /* shortcut taken by another app */
      }
    }
    if (!process.argv.includes('--hidden')) createWindow();
    const link = process.argv.find((a) => a.startsWith('kronos://'));
    if (link) handleDeepLink(link);
    if (backend.runtime?.config.updates.autoCheck !== false) setTimeout(() => void checkForUpdates(false), 10_000);
  });

  app.on('activate', () => {
    if (!win) createWindow();
    else win.show();
  });
  app.on('window-all-closed', () => {
    // the gateway keeps serving messaging platforms and automations from the tray
    if (!backend?.gateway || !prefs.closeToTray) void quit();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
}
