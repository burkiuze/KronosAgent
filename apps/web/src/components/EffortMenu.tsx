import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import { t } from '../lib/i18n';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number] | 'codemaster';

// ---------------------------------------------------------------------------
// Codemaster banner animation (canvas, a few hundred rects/frame, capped at 30 fps,
// mounted only while Codemaster is selected and the menu is open)

// 16×16 helmeted titan engineer with a glowing visor
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
// a pixel keytar held across the body; two strum poses
const KEYTAR = ['.........ll', '........l..', 'kwkwkwkwk..', 'kkkkkkkkk..'];
const HANDS = [
  ['..s....s', '........'],
  ['........', '..s....s'],
];
const NOTE = ['.cc', '.c.', 'cc.'];
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
  w: '#f5f3ff',
  l: '#c4b5fd',
  c: '#fde68a',
};

const CELL = 5; // css px per grid cell
const WAVE_EVERY = 1.6; // s between pixel waves
const WAVE_LIFE = 1.35; // s a wave travels before fading out
const LEVELS = 12; // opacity buckets for batched drawing

function drawSprite(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, px: number, alpha = 1): void {
  ctx.globalAlpha = alpha;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] as string;
    for (let c = 0; c < row.length; c++) {
      const fill = PALETTE[row[c] as string];
      if (!fill) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(Math.round(x + c * px), Math.round(y + r * px), Math.ceil(px), Math.ceil(px));
    }
  }
  ctx.globalAlpha = 1;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** Stable per-cell brightness jitter in [0, 1), so the grid shimmers like the reference. */
const grain = (c: number, r: number) => (((c * 73856093) ^ (r * 19349663)) >>> 0) % 997 / 997;
const easeOutBack = (v: number) => 1 + 2.4 * (v - 1) ** 3 + 1.4 * (v - 1) ** 2;

/** One frame of the banner at time `t` seconds after it was switched on. */
function drawFrame(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  ctx.clearRect(0, 0, w, h);
  const appear = clamp01(t / 0.35);
  const mx = w - 44;
  const my = h / 2;

  // purple field + glow behind the mascot
  ctx.globalAlpha = appear;
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#22163f');
  g.addColorStop(0.6, '#36256d');
  g.addColorStop(1, '#5236ad');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(mx, my, 4, mx, my, 70);
  glow.addColorStop(0, 'rgba(167,139,250,0.55)');
  glow.addColorStop(1, 'rgba(167,139,250,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(mx - 80, 0, 160, h);
  ctx.globalAlpha = 1;

  // stair-stepped pixel waves rolling left from the mascot. Cells are bucketed by opacity and
  // each bucket is filled as one path, so a frame costs ~a dozen draw calls instead of ~1,000.
  const rows = Math.ceil(h / CELL);
  const speed = (w + 40) / 1.15;
  const firstWave = 1.05;
  if (t > firstWave) {
    const buckets: Path2D[] = Array.from({ length: LEVELS }, () => new Path2D());
    const used = new Array<boolean>(LEVELS).fill(false);
    const cell = (x: number, y: number, a: number) => {
      const lvl = Math.min(LEVELS - 1, Math.floor(a * LEVELS));
      if (lvl <= 0) return;
      (buckets[lvl] as Path2D).rect(Math.round(x) + 0.5, y + 0.5, CELL - 1, CELL - 1);
      used[lvl] = true;
    };
    const k = Math.floor((t - firstWave) / WAVE_EVERY);
    for (const n of [k - 1, k]) {
      if (n < 0) continue;
      const age = t - firstWave - n * WAVE_EVERY;
      if (age < 0 || age > WAVE_LIFE) continue;
      const fade = (1 - age / WAVE_LIFE) ** 1.3;
      // a straight front rolls left; cells are brightest at the front and fade out behind it
      const front = age * speed;
      const band = w * 0.45;
      for (let x = mx - CELL, col = 0; x > -CELL; x -= CELL, col++) {
        const d = mx - x;
        if (d > front) break;
        const a = clamp01(1 - (front - d) / band) * fade;
        if (a * LEVELS < 1) continue;
        for (let r = 0; r < rows; r++) cell(x, r * CELL, a * (0.72 + 0.28 * grain(col + n * 7, r)));
      }
      // bright burst around the mascot as each wave starts
      if (age < 0.3) {
        const b = 1 - age / 0.3;
        const rad = 18 + age * 60;
        for (let y = 0; y < h; y += CELL)
          for (let x = mx - rad; x < Math.min(w, mx + rad); x += CELL) cell(x, y, b * clamp01(1 - Math.abs(x - mx) / rad));
      }
    }
    for (let lvl = 1; lvl < LEVELS; lvl++) {
      if (!used[lvl]) continue;
      ctx.fillStyle = `rgba(236,230,255,${((0.6 * lvl) / LEVELS).toFixed(3)})`;
      ctx.fill(buckets[lvl] as Path2D);
    }
  }

  // mascot pops in, then plays the keytar
  const pop = easeOutBack(clamp01((t - 0.12) / 0.4));
  if (pop <= 0) return;
  const px = 1.6 * pop;
  const playing = t > 0.6;
  const bob = playing ? Math.round(Math.sin(t * 7.5)) : 0;
  const sx = mx - (16 * px) / 2;
  const sy = my - (16 * px) / 2 + bob;
  drawSprite(ctx, SPRITE, sx, sy, px);
  if (playing) {
    const slide = clamp01((t - 0.6) / 0.25);
    const kx = sx + 2 * px + (1 - slide) * 10;
    const ky = sy + 11 * px;
    drawSprite(ctx, KEYTAR, kx, ky, px, slide);
    const pose = Math.floor(t / 0.22) % 2;
    drawSprite(ctx, HANDS[pose] as string[], kx, ky + 1.5 * px, px, slide);
    // notes float up and fade
    for (let i = 0; i < 4; i++) {
      const since = t - 0.9 - i * 0.37;
      if (since < 0) continue;
      const life = since % 1.48;
      if (life > 1.2) continue;
      const seed = (Math.floor(since / 1.48) * 7 + i * 13) % 5;
      const nx = sx + 14 * px + seed * 3 + life * 8;
      const ny = sy + 2 * px - life * 18;
      drawSprite(ctx, NOTE, nx, ny, 1.5, clamp01(1 - life / 1.2));
    }
  }
}

/** The animated banner behind the Codemaster row. */
function CodemasterCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let w = 0;
    let h = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      drawFrame(ctx, w, h, 2.4);
      return () => ro.disconnect();
    }
    const start = performance.now();
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 33) return; // ~30 fps is plenty for pixel art
      last = now;
      drawFrame(ctx, w, h, (now - start) / 1000);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);
  return <canvas ref={ref} className="cm-canvas" aria-hidden />;
}

/** The reasoning-effort picker: five levels plus Codemaster. */
export function EffortMenu({ value, onPick }: { value: EffortLevel; onPick: (v: EffortLevel) => void }) {
  const cm = value === 'codemaster';
  return (
    <div className="effort-menu" role="menu">
      <div className="effort-title">{t('effort.label')}</div>
      {EFFORT_LEVELS.map((lvl) => (
        <button key={lvl} role="menuitemradio" aria-checked={value === lvl} className={`effort-option ${value === lvl ? 'selected' : ''}`} onClick={() => onPick(lvl)}>
          <span className="effort-name">{t(`effort.${lvl}`)}</span>
          {lvl === 'medium' && <span className="effort-badge">{t('effort.recommended')}</span>}
          <span className="flex-1" />
          {value === lvl && <Check size={16} />}
        </button>
      ))}
      <button role="menuitemradio" aria-checked={cm} className={`effort-option codemaster ${cm ? 'on' : ''}`} onClick={() => onPick('codemaster')}>
        {cm && <CodemasterCanvas />}
        <span className="effort-name cm-name">Codemaster</span>
      </button>
      <p className="effort-foot">{t('effort.foot')}</p>
    </div>
  );
}
