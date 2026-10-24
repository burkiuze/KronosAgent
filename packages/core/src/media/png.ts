import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/** Tiny dependency-free PNG encoder (RGBA, 8-bit). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The Kronos titan, pixel art (32×32). Palette keys map to colors below.
// ---------------------------------------------------------------------------
const SPRITE = [
  '................................',
  '.............ggggg..............',
  '...........ggGGGGGgg............',
  '..ww......gGGYYYYYGGg......ww...',
  '.wWWw....gGYYYYYYYYYGg....wWWw..',
  '.wWWWw...gGYbbbbbbbYGg...wWWWw..',
  '..wWWWw..gGbBBBBBBBbGg..wWWWw...',
  '...wWWWwggGbBkBBBkBbGggwWWWw....',
  '....wWWWgGGbBBBBBBBbGGgWWWw.....',
  '.....wwwgGGGbbbbbbbGGGgwww......',
  '........ggGGGGGGGGGGGgg...hh....',
  '.......gbbgGGGYYYGGGgbbg..hYh...',
  '......gbBBbgGGYYYGGgbBBbg.hYh...',
  '.....gbBBBBbgGGGGGgbBBBBbghYh...',
  '.....gbBBYBBbgggggbBBYBBbghYh...',
  '.....gbBYYYBBbBBBbBBYYYBbghYh...',
  '.....gbBBYBBBbBYBbBBBYBBbgGGG...',
  '......gbBBBBbbBYBbbBBBBbgGYYYG..',
  '......ggbbbbGgbBbgGbbbbggGYOYG..',
  '.....gYYgggGGGgggGGGgggYYgGYYYG.',
  '.....gYYg.gGYYYYYYYGg.gYYg.GGG..',
  '.....ggg..gGbbbbbbbGg..ggg..hh..',
  '..........gbBBBBBBBbg.......hh..',
  '.........gbBBBbbbBBBbg......hh..',
  '.........gbBBbg.gbBBbg......hh..',
  '.........gbBBbg.gbBBbg......hh..',
  '.........gGYYGg.gGYYGg......hh..',
  '........gGGYYGg.gGYYGGg.....hh..',
  '........gGGGGGg.gGGGGGg.....hh..',
  '........ggggggg.ggggggg.....hh..',
  '................................',
  '................................',
];

type RGB = [number, number, number];

function hsl(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/**
 * Procedural "portrait of Kronos" used when no image provider is configured.
 * The prompt seeds the armor hue and background so each prompt gets a unique variant.
 */
export function kronosPortrait(prompt: string, size = 512): Buffer {
  const seed = createHash('sha256').update(prompt).digest();
  const hue = ((seed[0] as number) / 255) * 360;
  const palette: Record<string, RGB> = {
    g: [92, 64, 18], // gold outline
    G: [201, 152, 44], // gold
    Y: [247, 214, 102], // highlight
    b: hsl(hue, 0.55, 0.22), // armor dark
    B: hsl(hue, 0.6, 0.42), // armor
    k: [240, 250, 255], // eyes glow
    w: [120, 130, 150], // wing outline
    W: [225, 232, 245], // wing
    h: [110, 76, 40], // scythe handle
    O: hsl((hue + 180) % 360, 0.8, 0.55), // gem
  };
  const bgTop = hsl((hue + 200) % 360, 0.35, 0.93);
  const bgBottom = hsl((hue + 220) % 360, 0.4, 0.82);
  const px = 32;
  const scale = Math.floor(size / px);
  const dim = px * scale;
  const rgba = new Uint8Array(dim * dim * 4);
  for (let y = 0; y < dim; y += 1) {
    const t = y / dim;
    for (let x = 0; x < dim; x += 1) {
      const sy = Math.floor(y / scale);
      const sx = Math.floor(x / scale);
      const ch = SPRITE[sy]?.[sx] ?? '.';
      let c: RGB;
      if (ch !== '.' && palette[ch]) c = palette[ch] as RGB;
      else {
        // soft vertical gradient + subtle sparkle seeded by the prompt
        c = [0, 1, 2].map((i) => Math.round((bgTop[i] as number) * (1 - t) + (bgBottom[i] as number) * t)) as RGB;
        const s = seed[(sx * 7 + sy * 13) % seed.length] as number;
        if (s > 250 && (sx + sy) % 5 === 0) c = [255, 255, 255];
      }
      const o = (y * dim + x) * 4;
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = 255;
    }
  }
  return encodePng(dim, dim, rgba);
}
