/** Small BM25 index used for memory recall, skill matching and fallback session search. */

const STOP = new Set(
  'a an and are as at be but by for from has have he her his i in is it its me my of on or our she so that the their them they this to was we were what when where which who will with you your ve bir ve ile de da bu şu o ne için gibi'.split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export interface Bm25Doc<T> {
  id: string;
  text: string;
  data: T;
}

export class Bm25Index<T = unknown> {
  private docs: { id: string; data: T; tf: Map<string, number>; len: number }[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(docs: Bm25Doc<T>[] = [], private k1 = 1.4, private b = 0.75) {
    for (const d of docs) this.add(d);
  }

  add(doc: Bm25Doc<T>): void {
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.push({ id: doc.id, data: doc.data, tf, len: tokens.length });
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / this.docs.length;
  }

  search(query: string, limit = 10): { id: string; score: number; data: T }[] {
    const q = tokenize(query);
    if (!q.length) return [];
    const N = this.docs.length;
    const scored: { id: string; score: number; data: T }[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const term of q) {
        let tf = d.tf.get(term) ?? 0;
        if (!tf) {
          // cheap prefix matching so "deploy" finds "deployment"
          for (const [k, v] of d.tf) if (k.startsWith(term) && term.length >= 4) tf += v * 0.6;
        }
        if (!tf) continue;
        const df = this.df.get(term) ?? 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + (this.b * d.len) / (this.avgLen || 1)));
      }
      if (score > 0) scored.push({ id: d.id, score, data: d.data });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/** Return a short snippet of `text` around the first occurrence of any query term. */
export function snippet(text: string, query: string, radius = 120): string {
  const terms = tokenize(query);
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    pos = lower.indexOf(t);
    if (pos >= 0) break;
  }
  if (pos < 0) return text.slice(0, radius * 2).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}
