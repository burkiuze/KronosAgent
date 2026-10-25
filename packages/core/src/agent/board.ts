/**
 * A shared board for agents delegated together. There is no coordinator: members read it, post
 * findings others need, and claim work items so nobody duplicates them — the decentralized
 * pattern that let large agent teams keep scaling (claim → act → share → verify → merge).
 */
export interface BoardItem {
  id: string;
  title: string;
  status: 'open' | 'claimed' | 'done';
  owner?: string;
  note?: string;
  updatedAt: number;
}

export interface BoardPost {
  seq: number;
  author: string;
  text: string;
  at: number;
}

const MAX_POSTS = 400;
const MAX_POST_CHARS = 2000;

export class TeamBoard {
  readonly items: BoardItem[] = [];
  readonly posts: BoardPost[] = [];
  private seq = 0;
  private nextItem = 1;
  /** called for every post (the UI shows them live on the subagent cards) */
  onPost?: (post: BoardPost) => void;

  constructor(readonly members: string[]) {}

  add(title: string, owner?: string): BoardItem {
    const item: BoardItem = { id: `#${this.nextItem++}`, title: title.trim().slice(0, 200), status: owner ? 'claimed' : 'open', owner, updatedAt: Date.now() };
    this.items.push(item);
    return item;
  }

  private find(id: string): BoardItem {
    const key = id.startsWith('#') ? id : `#${id}`;
    const item = this.items.find((i) => i.id === key);
    if (!item) throw new Error(`no board item ${id}; items: ${this.items.map((i) => i.id).join(', ') || 'none'}`);
    return item;
  }

  /** Claim an open item. Claiming someone else's item fails, so two members never do the same work. */
  claim(id: string, member: string): BoardItem {
    const item = this.find(id);
    if (item.status === 'done') throw new Error(`${item.id} is already done (${item.owner ?? 'unknown'}: ${item.note ?? 'no note'})`);
    if (item.owner && item.owner !== member) throw new Error(`${item.id} is claimed by ${item.owner}`);
    item.owner = member;
    item.status = 'claimed';
    item.updatedAt = Date.now();
    return item;
  }

  complete(id: string, member: string, note?: string): BoardItem {
    const item = this.find(id);
    if (item.owner && item.owner !== member) throw new Error(`${item.id} is claimed by ${item.owner}; only the owner marks it done`);
    item.owner = member;
    item.status = 'done';
    item.note = note?.trim().slice(0, 300) || undefined;
    item.updatedAt = Date.now();
    return item;
  }

  post(author: string, text: string): BoardPost {
    const post: BoardPost = { seq: ++this.seq, author, text: text.trim().slice(0, MAX_POST_CHARS), at: Date.now() };
    this.posts.push(post);
    if (this.posts.length > MAX_POSTS) this.posts.splice(0, this.posts.length - MAX_POSTS);
    this.onPost?.(post);
    return post;
  }

  /** Posts after `since` (by sequence number), optionally excluding the reader's own. */
  read(since = 0, exclude?: string): BoardPost[] {
    return this.posts.filter((p) => p.seq > since && p.author !== exclude);
  }

  render(opts: { since?: number; reader?: string } = {}): string {
    const items = this.items.length
      ? this.items.map((i) => `${i.id} [${i.status}${i.owner ? ` · ${i.owner}` : ''}] ${i.title}${i.note ? ` — ${i.note}` : ''}`).join('\n')
      : '(no items)';
    const posts = this.read(opts.since ?? 0, opts.reader);
    const feed = posts.length ? posts.map((p) => `(${p.seq}) ${p.author}: ${p.text}`).join('\n') : '(no new posts)';
    return `Members: ${this.members.join(', ')}\n\nItems:\n${items}\n\nPosts${opts.since ? ` since ${opts.since}` : ''}:\n${feed}`;
  }
}
