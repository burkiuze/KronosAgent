/**
 * Splits streaming markdown into top-level blocks at blank lines, keeping fenced code and
 * indented continuations (list item paragraphs, nested content) with the block they belong to.
 */
export function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence = '';
  let gap = false;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      cur.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      continue;
    }
    if (!line.trim()) {
      if (cur.length) gap = true;
      cur.push(line);
      continue;
    }
    if (gap && !/^\s/.test(line)) {
      blocks.push(cur.join('\n'));
      cur = [];
    }
    gap = false;
    if (marker) fence = marker;
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks;
}
