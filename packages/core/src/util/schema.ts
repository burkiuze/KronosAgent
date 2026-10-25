import type { JSONSchema } from '../types.js';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value: Record<string, unknown>;
}

/**
 * Validate (and gently coerce) model-produced tool input against a JSON schema subset.
 * Models occasionally send numbers as strings or JSON-encoded arrays as strings; we
 * repair the obvious cases instead of bouncing the call back.
 */
export function validateInput(schema: JSONSchema, input: unknown): ValidationResult {
  const errors: string[] = [];
  let value: unknown = input ?? {};
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, errors: ['input is not a JSON object'], value: {} };
    }
  }
  const out = check(schema, value, '', errors);
  if (typeof out !== 'object' || out === null || Array.isArray(out)) {
    return { ok: false, errors: errors.length ? errors : ['input must be an object'], value: {} };
  }
  return { ok: errors.length === 0, errors, value: out as Record<string, unknown> };
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(expected: string, v: unknown): boolean {
  const t = typeOf(v);
  if (expected === 'number') return t === 'number' || t === 'integer';
  return expected === t;
}

function coerce(expected: string, v: unknown): unknown {
  if (typeof v === 'string') {
    const s = v.trim();
    if ((expected === 'number' || expected === 'integer') && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (expected === 'boolean' && (s === 'true' || s === 'false')) return s === 'true';
    if ((expected === 'array' && s.startsWith('[')) || (expected === 'object' && s.startsWith('{'))) {
      try {
        return JSON.parse(s);
      } catch {
        return v;
      }
    }
  }
  if (expected === 'string' && (typeof v === 'number' || typeof v === 'boolean')) return String(v);
  if (expected === 'array' && v !== undefined && v !== null && !Array.isArray(v) && typeof v !== 'object') return [v];
  return v;
}

function check(schema: JSONSchema, v: unknown, path: string, errors: string[]): unknown {
  if (!schema || typeof schema !== 'object') return v;
  const label = path || 'input';

  if (schema.anyOf || schema.oneOf) {
    const options = (schema.anyOf ?? schema.oneOf) as JSONSchema[];
    for (const opt of options) {
      const errs: string[] = [];
      const out = check(opt, v, path, errs);
      if (errs.length === 0) return out;
    }
    errors.push(`${label}: does not match any allowed shape`);
    return v;
  }

  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.length) {
    if (!types.some((t) => matchesType(t, v))) {
      let fixed: unknown = v;
      for (const t of types) {
        const c = coerce(t, v);
        if (matchesType(t, c)) {
          fixed = c;
          break;
        }
      }
      if (!types.some((t) => matchesType(t, fixed))) {
        errors.push(`${label}: expected ${types.join('|')}, got ${typeOf(v)}`);
        return v;
      }
      v = fixed;
    }
  }

  if (schema.enum && !schema.enum.includes(v)) {
    errors.push(`${label}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }

  if (typeof v === 'number') {
    if (typeof schema.minimum === 'number' && v < schema.minimum) errors.push(`${label}: must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && v > schema.maximum) errors.push(`${label}: must be <= ${schema.maximum}`);
  }

  if (Array.isArray(v)) {
    if (typeof schema.minItems === 'number' && v.length < schema.minItems) errors.push(`${label}: needs at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) errors.push(`${label}: at most ${schema.maxItems} items`);
    if (schema.items) return v.map((item, i) => check(schema.items as JSONSchema, item, `${label}[${i}]`, errors));
    return v;
  }

  if (typeOf(v) === 'object') {
    const obj = adoptAliases(schema, { ...(v as Record<string, unknown>) });
    for (const req of schema.required ?? []) {
      if (obj[req] === undefined || obj[req] === null) errors.push(`${path ? `${path}.` : ''}${req}: is required`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] === undefined) continue;
      if (obj[key] === null && !(sub.type === 'null' || (Array.isArray(sub.type) && sub.type.includes('null')))) {
        delete obj[key];
        continue;
      }
      obj[key] = check(sub, obj[key], path ? `${path}.${key}` : key, errors);
    }
    return obj;
  }
  return v;
}

/**
 * Argument names models use for our parameters — from other agents' tool sets (Claude Code,
 * Cline, OpenHands, Codex …) that weaker models fall back to. Matched case- and punctuation-
 * insensitively; only used when the real parameter is missing.
 */
const PARAM_ALIASES: Record<string, string[]> = {
  path: ['filepath', 'file', 'filename', 'targetfile', 'target', 'absolutepath', 'relativepath', 'dir', 'directory', 'dirpath', 'folder', 'location', 'fullpath'],
  command: ['cmd', 'script', 'shellcommand', 'bashcommand', 'commandline', 'commands', 'shell', 'bash', 'code'],
  content: ['contents', 'text', 'body', 'data', 'filecontent', 'filetext', 'code', 'newcontent', 'source', 'filecontents'],
  old_string: ['oldstr', 'oldtext', 'old', 'search', 'find', 'original', 'from', 'before', 'targettext', 'searchstring', 'findtext', 'oldcontent', 'oldcode'],
  new_string: ['newstr', 'newtext', 'new', 'replace', 'replacement', 'to', 'after', 'replacestring', 'replacetext', 'newcontent', 'newcode'],
  pattern: ['regex', 'query', 'search', 'glob', 'q', 'expression', 'searchterm', 'searchpattern', 'term'],
  query: ['q', 'search', 'searchquery', 'term', 'keywords', 'question', 'text'],
  url: ['link', 'uri', 'href', 'address', 'website', 'page'],
  todos: ['items', 'tasks', 'list', 'todo', 'todolist', 'plan'],
  question: ['prompt', 'message', 'text', 'query'],
  patch: ['diff', 'patchtext', 'input'],
  edits: ['changes', 'replacements', 'operations'],
};

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Moves a misnamed argument (file_path, cmd, old_str, oldString …) onto the parameter it means. */
function adoptAliases(schema: JSONSchema, obj: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties ?? {};
  const own = new Set(Object.keys(props));
  for (const prop of own) {
    if (obj[prop] !== undefined) continue;
    const wanted = new Set([normKey(prop), ...(PARAM_ALIASES[prop] ?? [])]);
    const key = Object.keys(obj).find((k) => !own.has(k) && obj[k] !== undefined && wanted.has(normKey(k)));
    if (key) {
      obj[prop] = obj[key];
      delete obj[key];
    }
  }
  return obj;
}

/** Build a compact human readable signature from a schema (for docs/help). */
export function describeSchema(schema: JSONSchema): string {
  const props = schema.properties ?? {};
  const req = new Set(schema.required ?? []);
  return Object.entries(props)
    .map(([k, s]) => `${k}${req.has(k) ? '' : '?'}: ${Array.isArray(s.type) ? s.type.join('|') : (s.type ?? 'any')}`)
    .join(', ');
}
