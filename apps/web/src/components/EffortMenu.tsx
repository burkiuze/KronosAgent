import { useMemo, type ReactElement } from 'react';
import { Check } from 'lucide-react';
import { t } from '../lib/i18n';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number] | 'codemaster';

// 16×16 pixel sprite: a helmeted titan engineer with a glowing visor
const SPRITE = [
  '......rrr.......',
  '.....rrrrr......',
  '....kkkkkkk.....',
  '...khhhhhhhk....',
  '..khhhhhhhhhk...',
  '..khkkkkkkkhk...',
  '..khvvvvvvvhk...',
  '..khkkkkkkkhk...',
  '..kHsssssssHk...',
  '...kssSSSssk....',
  '....kkkkkkk.....',
  '...kpppppppk....',
  '..kpPppppPppk...',
  '..kpPppppPppk...',
  '..kpPPPPPPPpk...',
  '...kkkkkkkkk....',
];
// "</>" in 5-row pixel glyphs
const GLYPH_PARTS = [
  ['..c', '.c.', 'c..', '.c.', '..c'],
  ['....c', '...c.', '..c..', '.c...', 'c....'],
  ['c..', '.c.', '..c', '.c.', 'c..'],
];
const CODE_GLYPH = GLYPH_PARTS[0]!.map((_, r) => GLYPH_PARTS.map((part) => part[r]).join('.'));
const PALETTE: Record<string, string> = {
  k: '#1a0f33',
  h: '#f2c94c',
  H: '#c9971f',
  s: '#f0a477',
  S: '#d9805a',
  v: '#5eead4',
  r: '#ef6b6b',
  p: '#8b5cf6',
  P: '#6d3fd9',
  c: '#fde68a',
};

function pixels(rows: string[], x0: number, y0: number, size: number, keyPrefix: string) {
  const out: ReactElement[] = [];
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const fill = PALETTE[ch];
      if (fill) out.push(<rect key={`${keyPrefix}${x}-${y}`} x={x0 + x * size} y={y0 + y * size} width={size} height={size} fill={fill} />);
    }),
  );
  return out;
}

/** Purple pixel-grid banner with the Codemaster mascot. */
function CodemasterArt() {
  const cells = useMemo(() => {
    const out: { x: number; y: number; a: number }[] = [];
    const cols = 44;
    const rows = 8;
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let x = 0; x < cols; x++)
      for (let y = 0; y < rows; y++) {
        const pos = x / cols;
        const a = rand() < 0.55 ? (0.05 + rand() * 0.28) * (0.35 + pos) : 0;
        if (a > 0.02) out.push({ x: x * 8, y: y * 8, a });
      }
    return out;
  }, []);
  return (
    <svg className="cm-art" viewBox="0 0 352 64" preserveAspectRatio="xMaxYMid slice" aria-hidden>
      <defs>
        <linearGradient id="cmg" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#24163f" />
          <stop offset="0.55" stopColor="#3b2675" />
          <stop offset="1" stopColor="#6a49d1" />
        </linearGradient>
      </defs>
      <rect width="352" height="64" fill="url(#cmg)" />
      {cells.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x + 0.5} y={c.y + 0.5} width="7" height="7" fill="#ffffff" opacity={c.a} />
      ))}
      <rect x="280" y="0" width="72" height="64" fill="#c4b5fd" opacity="0.18" />
      {pixels(CODE_GLYPH, 226, 24, 3, 'g')}
      {pixels(SPRITE, 288, 4, 3.5, 's')}
    </svg>
  );
}

/** The reasoning-effort picker: five levels plus Codemaster. */
export function EffortMenu({ value, onPick }: { value: EffortLevel; onPick: (v: EffortLevel) => void }) {
  return (
    <div className="effort-menu" role="menu">
      {EFFORT_LEVELS.map((lvl) => (
        <button key={lvl} role="menuitemradio" aria-checked={value === lvl} className={`effort-option ${value === lvl ? 'selected' : ''}`} onClick={() => onPick(lvl)}>
          <span className="effort-name">{t(`effort.${lvl}`)}</span>
          {lvl === 'medium' && <span className="effort-badge">{t('effort.recommended')}</span>}
          <span className="flex-1" />
          {value === lvl && <Check size={16} />}
        </button>
      ))}
      <button role="menuitemradio" aria-checked={value === 'codemaster'} className={`effort-option codemaster ${value === 'codemaster' ? 'selected' : ''}`} onClick={() => onPick('codemaster')}>
        <CodemasterArt />
        <span className="cm-text">
          <span className="effort-name">Codemaster</span>
          <small>{t('effort.codemasterHint')}</small>
        </span>
        {value === 'codemaster' && <Check size={16} className="cm-check" />}
      </button>
    </div>
  );
}
