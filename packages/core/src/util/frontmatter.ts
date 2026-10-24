import YAML from 'yaml';

export interface Frontmatter<T = Record<string, unknown>> {
  data: T;
  body: string;
}

/** Parse `---\nyaml\n---\nbody` documents (SKILL.md, agents, commands). */
export function parseFrontmatter<T = Record<string, unknown>>(src: string): Frontmatter<T> {
  const text = src.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {} as T, body: text };
  let data: unknown = {};
  try {
    data = YAML.parse(m[1] ?? '') ?? {};
  } catch {
    data = {};
  }
  return { data: (typeof data === 'object' && data !== null ? data : {}) as T, body: (m[2] ?? '').replace(/^\r?\n/, '') };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  return `---\n${YAML.stringify(clean).trimEnd()}\n---\n\n${body.trim()}\n`;
}
