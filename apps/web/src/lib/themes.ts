export type ColorMode = 'light' | 'dark' | 'system';

export interface ThemeTokens {
  bg: string;
  panel: string;
  sidebar: string;
  elev: string;
  hover: string;
  border: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  accentFg: string;
  accentSoft: string;
  user: string;
  code: string;
  danger: string;
  success: string;
  warning: string;
  wallpaper: string;
}

export interface Theme {
  id: string;
  name: string;
  description: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

const base = {
  danger: '#d64545',
  success: '#2f9e5b',
  warning: '#c98a14',
};

export const THEMES: Theme[] = [
  {
    id: 'kronos',
    name: 'Kronos',
    description: 'Glass neutrals with titan-gold accents',
    light: {
      ...base, bg: '#f6f5f1', panel: '#fbfaf7', sidebar: '#f0eee8', elev: '#ffffff', hover: '#ebe8df', border: '#e2ded3', text: '#1d1b16',
      dim: '#5d584c', faint: '#9a9484', accent: '#b8862b', accentFg: '#ffffff', accentSoft: '#f3e7cc', user: '#ffffff', code: '#f1eee6',
      wallpaper: 'radial-gradient(1200px 600px at 10% -10%, #f6e7c4 0%, transparent 60%), radial-gradient(900px 500px at 110% 110%, #e6ecf5 0%, transparent 60%)',
    },
    dark: {
      ...base, bg: '#13120f', panel: '#181713', sidebar: '#110f0c', elev: '#201e19', hover: '#26231d', border: '#2e2a22', text: '#ece7da',
      dim: '#aaa291', faint: '#6f6858', accent: '#d9a441', accentFg: '#17130a', accentSoft: '#3a2f18', user: '#1f1c16', code: '#1c1a15',
      wallpaper: 'radial-gradient(1200px 600px at 10% -10%, #2b2312 0%, transparent 60%), radial-gradient(900px 500px at 110% 110%, #18202b 0%, transparent 60%)',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Deep blue-violet with cool accents',
    light: {
      ...base, bg: '#f4f5fb', panel: '#f9f9fe', sidebar: '#eceef9', elev: '#ffffff', hover: '#e3e6f6', border: '#d9ddf0', text: '#181a2e',
      dim: '#55597a', faint: '#8f93b3', accent: '#5b5bd6', accentFg: '#ffffff', accentSoft: '#e1e1fb', user: '#ffffff', code: '#eef0fb', wallpaper: 'none',
    },
    dark: {
      ...base, bg: '#0b0b1d', panel: '#0f1024', sidebar: '#09091a', elev: '#16173a', hover: '#1b1d44', border: '#24264f', text: '#e4e4fb',
      dim: '#a3a5d1', faint: '#64679a', accent: '#8b8cf6', accentFg: '#0b0b1d', accentSoft: '#25265a', user: '#15163a', code: '#121331',
      wallpaper: 'radial-gradient(1000px 600px at 80% -20%, #1d1b52 0%, transparent 60%)',
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Warm crimson and bronze — forge vibes',
    light: {
      ...base, bg: '#fbf5f1', panel: '#fdf9f6', sidebar: '#f5ebe4', elev: '#ffffff', hover: '#f0e0d6', border: '#ead6c9', text: '#2a1710',
      dim: '#6d4a3b', faint: '#a88272', accent: '#c2452d', accentFg: '#ffffff', accentSoft: '#f7dcd2', user: '#ffffff', code: '#f6ebe4', wallpaper: 'none',
    },
    dark: {
      ...base, bg: '#160c08', panel: '#1b0f0a', sidebar: '#120906', elev: '#26150e', hover: '#2e1a11', border: '#3a2216', text: '#f3dfd2',
      dim: '#c5a08c', faint: '#7f5c4b', accent: '#f0a070', accentFg: '#1b0f0a', accentSoft: '#432417', user: '#24140d', code: '#21120c',
      wallpaper: 'radial-gradient(1000px 600px at 0% 100%, #3b1409 0%, transparent 60%)',
    },
  },
  {
    id: 'mono',
    name: 'Mono',
    description: 'Clean grayscale — minimal and focused',
    light: {
      ...base, bg: '#f7f7f7', panel: '#fbfbfb', sidebar: '#f0f0f0', elev: '#ffffff', hover: '#e8e8e8', border: '#e0e0e0', text: '#111111',
      dim: '#555555', faint: '#999999', accent: '#111111', accentFg: '#ffffff', accentSoft: '#e6e6e6', user: '#ffffff', code: '#f0f0f0', wallpaper: 'none',
    },
    dark: {
      ...base, bg: '#0d0d0d', panel: '#121212', sidebar: '#0a0a0a', elev: '#1a1a1a', hover: '#202020', border: '#2a2a2a', text: '#ececec',
      dim: '#a8a8a8', faint: '#666666', accent: '#f2f2f2', accentFg: '#0d0d0d', accentSoft: '#2b2b2b', user: '#171717', code: '#161616', wallpaper: 'none',
    },
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    description: 'Neon green on black — matrix terminal',
    light: {
      ...base, bg: '#f2fbf3', panel: '#f7fdf7', sidebar: '#e6f6e8', elev: '#ffffff', hover: '#dcf2df', border: '#c9e8cd', text: '#0b2210',
      dim: '#3e6b45', faint: '#7aa281', accent: '#0f9d3a', accentFg: '#ffffff', accentSoft: '#d2f2da', user: '#ffffff', code: '#e9f7eb', wallpaper: 'none',
    },
    dark: {
      ...base, bg: '#020602', panel: '#040a04', sidebar: '#010401', elev: '#081208', hover: '#0c1a0c', border: '#143014', text: '#b8f7c0',
      dim: '#5fd16f', faint: '#2f7a3a', accent: '#39ff5a', accentFg: '#021002', accentSoft: '#0e2e12', user: '#071107', code: '#061006',
      wallpaper: 'repeating-linear-gradient(0deg, rgba(57,255,90,0.025) 0px, rgba(57,255,90,0.025) 1px, transparent 1px, transparent 3px)',
    },
  },
  {
    id: 'slate',
    name: 'Slate',
    description: 'Cool slate blue — focused developer theme',
    light: {
      ...base, bg: '#f3f5f8', panel: '#f8fafc', sidebar: '#eaeef3', elev: '#ffffff', hover: '#e0e6ee', border: '#d6dde7', text: '#141b26',
      dim: '#4f5d70', faint: '#8a97a8', accent: '#3b6fd6', accentFg: '#ffffff', accentSoft: '#dde7fa', user: '#ffffff', code: '#edf1f6', wallpaper: 'none',
    },
    dark: {
      ...base, bg: '#0e131b', panel: '#121822', sidebar: '#0b1017', elev: '#18202c', hover: '#1d2633', border: '#26303f', text: '#dde5f0',
      dim: '#9aa8bb', faint: '#5d6b7e', accent: '#7aa7ff', accentFg: '#0b1017', accentSoft: '#1f2c45', user: '#161e29', code: '#141b25', wallpaper: 'none',
    },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Teal-violet northern lights',
    light: {
      ...base, bg: '#f3f7f8', panel: '#f8fbfb', sidebar: '#e9f1f2', elev: '#ffffff', hover: '#dfeced', border: '#d3e3e5', text: '#10222a',
      dim: '#47616b', faint: '#86a0a8', accent: '#138a8a', accentFg: '#ffffff', accentSoft: '#d5efef', user: '#ffffff', code: '#ebf3f4',
      wallpaper: 'radial-gradient(900px 500px at 100% 0%, #d8f1ef 0%, transparent 60%), radial-gradient(900px 500px at 0% 100%, #eadff7 0%, transparent 60%)',
    },
    dark: {
      ...base, bg: '#081215', panel: '#0b171b', sidebar: '#060e11', elev: '#102127', hover: '#14292f', border: '#1b343b', text: '#d9f2f2',
      dim: '#8fbcbf', faint: '#4f7c80', accent: '#4fd1c5', accentFg: '#061113', accentSoft: '#123a3b', user: '#0e1e23', code: '#0d1b1f',
      wallpaper: 'radial-gradient(900px 500px at 100% 0%, #0f3b3a 0%, transparent 60%), radial-gradient(900px 500px at 0% 100%, #2a1747 0%, transparent 60%)',
    },
  },
  {
    id: 'sakura',
    name: 'Sakura',
    description: 'Soft blossom pinks — calm and bright',
    light: {
      ...base, bg: '#fcf6f8', panel: '#fefafb', sidebar: '#f7ecf0', elev: '#ffffff', hover: '#f3e1e8', border: '#ecd7df', text: '#2a141c',
      dim: '#74505e', faint: '#ae8b98', accent: '#d0577f', accentFg: '#ffffff', accentSoft: '#f9dde7', user: '#ffffff', code: '#f8ecf0',
      wallpaper: 'radial-gradient(900px 500px at 0% 0%, #fbe1ea 0%, transparent 60%)',
    },
    dark: {
      ...base, bg: '#160d11', panel: '#1b1015', sidebar: '#12090d', elev: '#26161d', hover: '#2e1b23', border: '#3a222c', text: '#f6e1e8',
      dim: '#cb9fb0', faint: '#835d6b', accent: '#f08cae', accentFg: '#1b1015', accentSoft: '#45202f', user: '#22131a', code: '#1f1117', wallpaper: 'none',
    },
  },
];

export function resolveMode(mode: ColorMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(themeId: string, mode: ColorMode, opts: { fontSize?: number; density?: string } = {}): void {
  const theme = THEMES.find((t) => t.id === themeId) ?? (THEMES[0] as Theme);
  const resolved = resolveMode(mode);
  const t = theme[resolved];
  const root = document.documentElement;
  const map: Record<string, string> = {
    '--bg': t.bg, '--panel': t.panel, '--sidebar': t.sidebar, '--elev': t.elev, '--hover': t.hover, '--border': t.border, '--text': t.text,
    '--dim': t.dim, '--faint': t.faint, '--accent': t.accent, '--accent-fg': t.accentFg, '--accent-soft': t.accentSoft, '--user': t.user,
    '--code': t.code, '--danger': t.danger, '--success': t.success, '--warning': t.warning, '--wallpaper': t.wallpaper,
  };
  for (const [k, v] of Object.entries(map)) root.style.setProperty(k, v);
  root.dataset.theme = theme.id;
  root.dataset.mode = resolved;
  root.style.colorScheme = resolved;
  if (opts.fontSize) root.style.setProperty('--font-size', `${opts.fontSize}px`);
  root.dataset.density = opts.density ?? 'comfortable';
  try {
    localStorage.setItem('kronos.theme', JSON.stringify({ themeId, mode, fontSize: opts.fontSize, density: opts.density }));
  } catch {
    /* ignore */
  }
}

/** Apply the last theme synchronously at startup to avoid a flash. */
export function bootTheme(): void {
  try {
    const saved = JSON.parse(localStorage.getItem('kronos.theme') ?? 'null') as { themeId: string; mode: ColorMode; fontSize?: number; density?: string } | null;
    applyTheme(saved?.themeId ?? 'kronos', saved?.mode ?? 'system', { fontSize: saved?.fontSize, density: saved?.density });
  } catch {
    applyTheme('kronos', 'system');
  }
}
