import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** Minimal dotenv parser supporting quotes, `export`, comments and escaped newlines. */
export function parseDotenv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    let val = (m[2] ?? '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      const q = val[0];
      val = val.slice(1, -1);
      if (q === '"') val = val.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

export function loadDotenv(file: string, override = false): Record<string, string> {
  if (!existsSync(file)) return {};
  const vars = parseDotenv(readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(vars)) {
    if (override || process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  }
  return vars;
}

/** Set or remove keys in a .env file while preserving unrelated lines and comments. */
export function updateDotenv(file: string, updates: Record<string, string | null>): void {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const out: string[] = [];
  for (const line of lines) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line.trim());
    if (m && pending.has(m[1] as string)) {
      const v = pending.get(m[1] as string);
      pending.delete(m[1] as string);
      if (v === null || v === undefined) continue;
      out.push(`${m[1]}=${quote(v)}`);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of pending) if (v !== null && v !== undefined) out.push(`${k}=${quote(v)}`);
  while (out.length && out[out.length - 1] === '') out.pop();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${out.join('\n')}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
}

function quote(v: string): string {
  return /[\s#"'\\]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : v;
}

/** Expand ${VAR} and ${VAR:-default} references inside config strings. */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => {
    const v = process.env[name];
    return v !== undefined && v !== '' ? v : (def ?? '');
  });
}

export function expandEnvDeep<T>(value: T): T {
  if (typeof value === 'string') return expandEnv(value) as T;
  if (Array.isArray(value)) return value.map((v) => expandEnvDeep(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandEnvDeep(v)])) as T;
  }
  return value;
}
