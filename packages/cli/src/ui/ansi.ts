const enabled = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (open: number | string, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  enabled,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  gold: wrap('38;5;178', 39),
  amber: wrap('38;5;214', 39),
  bronze: wrap('38;5;137', 39),
  bgGray: wrap('48;5;236', 49),
  bgGreen: wrap('48;5;22', 49),
  bgRed: wrap('48;5;52', 49),
};

export const sym = {
  prompt: '❯',
  tool: '⏺',
  result: '⎿',
  ok: '✓',
  fail: '✗',
  warn: '⚠',
  info: 'ℹ',
  think: '✻',
  bullet: '•',
  hourglass: '⧗',
};

export function termWidth(): number {
  return Math.max(40, Math.min(process.stdout.columns || 100, 160));
}

export function hr(char = '─'): string {
  return c.gray(char.repeat(termWidth()));
}

export const LOGO = [
  '  ██╗  ██╗██████╗  ██████╗ ███╗   ██╗ ██████╗ ███████╗',
  '  ██║ ██╔╝██╔══██╗██╔═══██╗████╗  ██║██╔═══██╗██╔════╝',
  '  █████╔╝ ██████╔╝██║   ██║██╔██╗ ██║██║   ██║███████╗',
  '  ██╔═██╗ ██╔══██╗██║   ██║██║╚██╗██║██║   ██║╚════██║',
  '  ██║  ██╗██║  ██║╚██████╔╝██║ ╚████║╚██████╔╝███████║',
  '  ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝',
];

export function logo(): string {
  const shades = ['38;5;222', '38;5;221', '38;5;220', '38;5;214', '38;5;208', '38;5;172'];
  return LOGO.map((l, i) => (enabled ? `\x1b[${shades[i]}m${l}\x1b[39m` : l)).join('\n');
}
