/** Minimal browser-side frontmatter split (key: value lines only; enough for display). */
export function parseFrontmatter(src: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, unknown> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1] as string] = (kv[2] ?? '').replace(/^["']|["']$/g, '');
  }
  return { data, body: (m[2] ?? '').trim() };
}
