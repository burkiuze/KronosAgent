/**
 * Cron expression engine (5 fields, Vixie semantics) with timezone support and a
 * natural-language front end: "every 15 minutes", "every day at 9am",
 * "weekdays at 18:30", "every monday at 08:00", "in 2 hours", "tomorrow at 7".
 */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

function parseField(field: string, min: number, max: number, names?: string[]): Set<number> {
  const out = new Set<number>();
  for (const part of field.toLowerCase().split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error(`invalid step in "${field}"`);
    let lo = min;
    let hi = max;
    const toNum = (s: string): number => {
      if (names) {
        const idx = names.indexOf(s.slice(0, 3));
        if (idx >= 0) return idx + min;
      }
      const n = parseInt(s, 10);
      if (!Number.isFinite(n)) throw new Error(`invalid value "${s}" in "${field}"`);
      return n;
    };
    if (rangePart && rangePart !== '*') {
      if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-');
        lo = toNum(a as string);
        hi = toNum(b as string);
      } else {
        lo = toNum(rangePart);
        hi = stepPart ? max : lo;
      }
    }
    if (lo < min || hi > max || lo > hi) {
      // allow 7 as Sunday for day-of-week
      if (!(max === 6 && hi === 7)) throw new Error(`value out of range in "${field}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(max === 6 && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const e = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const fields = e.split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expression must have 5 fields: "${expr}"`);
  const [mi, h, dom, mon, dow] = fields as [string, string, string, string, string];
  return {
    minute: parseField(mi, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12, MONTHS),
    dow: parseField(dow, 0, 6, DAYS),
    domStar: dom === '*' || dom === '?',
    dowStar: dow === '*' || dow === '?',
  };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dow: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function wallClock(ts: number, tz?: string): WallClock {
  const key = tz ?? 'local';
  let fmt = fmtCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
    });
    fmtCache.set(key, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ts))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    dow: DAYS.indexOf((parts.weekday ?? 'sun').toLowerCase().slice(0, 3)),
  };
}

function dayMatches(spec: CronSpec, w: WallClock): boolean {
  const domOk = spec.dom.has(w.day);
  const dowOk = spec.dow.has(w.dow);
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowOk;
  if (spec.dowStar) return domOk;
  return domOk || dowOk;
}

/** Next fire time strictly after `from` (ms epoch), or null if none within ~5 years. */
export function nextCronTime(exprOrSpec: string | CronSpec, from = Date.now(), tz?: string): number | null {
  const spec = typeof exprOrSpec === 'string' ? parseCron(exprOrSpec) : exprOrSpec;
  let t = Math.floor(from / 60000) * 60000 + 60000;
  const limit = from + 5 * 366 * 24 * 3600 * 1000;
  let guard = 0;
  while (t < limit && guard++ < 500000) {
    const w = wallClock(t, tz);
    if (!spec.month.has(w.month) || !dayMatches(spec, w)) {
      t += ((23 - w.hour) * 60 + (60 - w.minute)) * 60000; // jump to next local midnight
      continue;
    }
    if (!spec.hour.has(w.hour)) {
      t += (60 - w.minute) * 60000;
      continue;
    }
    if (!spec.minute.has(w.minute)) {
      t += 60000;
      continue;
    }
    return t;
  }
  return null;
}

export interface ParsedSchedule {
  kind: 'cron' | 'interval' | 'once';
  cron?: string;
  intervalMs?: number;
  at?: number;
  description: string;
}

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000,
  w: 604800000, week: 604800000, weeks: 604800000,
};

function parseTimeOfDay(s: string): { h: number; m: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) return null;
  let h = parseInt(m[1] as string, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/**
 * Parse a schedule written by a human or the model. Accepts raw cron, macros,
 * ISO timestamps and common English phrases.
 */
export function parseSchedule(input: string, now = Date.now()): ParsedSchedule {
  const s = input.trim();
  const lower = s.toLowerCase().replace(/\s+/g, ' ');
  if (MACROS[lower] || /^[\d*?/,a-z-]+( [\d*?/,a-z-]+){4}$/i.test(s)) {
    if (isValidCron(s)) return { kind: 'cron', cron: MACROS[lower] ?? s, description: `cron ${s}` };
  }
  const iso = Date.parse(s);
  if (/\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(iso)) return { kind: 'once', at: iso, description: `once at ${new Date(iso).toISOString()}` };

  let m = /^(?:in )?(\d+(?:\.\d+)?) ?([a-z]+)(?: from now)?$/.exec(lower);
  if (m && /^in /.test(lower)) {
    const ms = UNIT_MS[m[2] as string];
    if (ms) return { kind: 'once', at: now + Number(m[1]) * ms, description: `once ${s}` };
  }
  m = /^every (\d+)? ?([a-z]+)$/.exec(lower);
  if (m) {
    const n = m[1] ? parseInt(m[1], 10) : 1;
    const unit = m[2] as string;
    const ms = UNIT_MS[unit];
    if (ms) {
      if (ms === 60000 && 60 % n === 0) return { kind: 'cron', cron: `*/${n} * * * *`, description: `every ${n} minute(s)` };
      if (ms === 3600000 && 24 % n === 0) return { kind: 'cron', cron: `0 */${n} * * *`, description: `every ${n} hour(s)` };
      if (ms === 86400000 && n === 1) return { kind: 'cron', cron: '0 9 * * *', description: 'every day at 09:00' };
      return { kind: 'interval', intervalMs: n * ms, description: `every ${n} ${unit}` };
    }
    if (unit === 'weekday' || unit === 'weekdays') return { kind: 'cron', cron: '0 9 * * 1-5', description: 'weekdays at 09:00' };
  }
  m = /^(every day|daily|each day|every weekday|weekdays|every weekend|weekends|every (sun|mon|tue|wed|thu|fri|sat)[a-z]*|(?:on )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*s?|tomorrow|today)(?: at ([\d:apm ]+))?$/.exec(lower);
  if (m) {
    const tod = m[4] ? parseTimeOfDay(m[4]) : { h: 9, m: 0 };
    if (!tod) throw new Error(`could not understand time in "${input}"`);
    const head = m[1] as string;
    const dayName = m[2] ?? m[3];
    if (head === 'tomorrow' || head === 'today') {
      const d = new Date(now);
      if (head === 'tomorrow') d.setDate(d.getDate() + 1);
      d.setHours(tod.h, tod.m, 0, 0);
      return { kind: 'once', at: d.getTime(), description: `once ${head} at ${pad(tod.h)}:${pad(tod.m)}` };
    }
    let dow = '*';
    if (/weekday/.test(head)) dow = '1-5';
    else if (/weekend/.test(head)) dow = '0,6';
    else if (dayName) dow = String(DAYS.indexOf(dayName));
    const cron = `${tod.m} ${tod.h} * * ${dow}`;
    return { kind: 'cron', cron, description: `${head} at ${pad(tod.h)}:${pad(tod.m)}` };
  }
  m = /^(?:at )?([\d:]+ ?(?:am|pm)?) (?:every day|daily)$/.exec(lower);
  if (m) {
    const tod = parseTimeOfDay(m[1] as string);
    if (tod) return { kind: 'cron', cron: `${tod.m} ${tod.h} * * *`, description: `daily at ${pad(tod.h)}:${pad(tod.m)}` };
  }
  m = /^(?:every )?hourly$/.exec(lower);
  if (m) return { kind: 'cron', cron: '0 * * * *', description: 'every hour' };
  m = /^(?:every )?(weekly|monthly)$/.exec(lower);
  if (m) return { kind: 'cron', cron: m[1] === 'weekly' ? '0 9 * * 1' : '0 9 1 * *', description: m[1] as string };
  throw new Error(
    `Unrecognized schedule "${input}". Use cron ("0 9 * * 1-5"), "every 30 minutes", "every day at 9am", "weekdays at 18:00", "every monday at 8", "in 2 hours", or an ISO time.`,
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function describeCron(expr: string): string {
  const f = (MACROS[expr] ?? expr).split(/\s+/);
  if (f.length !== 5) return expr;
  const [mi, h, dom, mon, dow] = f;
  if (mi?.startsWith('*/') && h === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${mi.slice(2)} min`;
  if (mi === '0' && h === '*' && dom === '*') return 'hourly';
  if (mi === '0' && h?.startsWith('*/')) return `every ${h.slice(2)} h`;
  if (/^\d+$/.test(mi ?? '') && /^\d+$/.test(h ?? '') && dom === '*' && mon === '*') {
    const time = `${pad(Number(h))}:${pad(Number(mi))}`;
    if (dow === '*') return `daily ${time}`;
    if (dow === '1-5') return `weekdays ${time}`;
    if (dow === '0,6') return `weekends ${time}`;
    if (/^\d$/.test(dow ?? '')) return `${DAYS[Number(dow)]} ${time}`;
  }
  return expr;
}
