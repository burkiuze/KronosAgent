import { getLang } from './i18n';

export function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  const tr = getLang() === 'tr';
  if (s < 45) return tr ? 'şimdi' : 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${tr ? 'dk' : 'm'}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${tr ? 'sa' : 'h'}`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}${tr ? 'g' : 'd'}`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function cost(usd = 0): string {
  if (!usd) return '$0';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const s = (v: unknown, max = 60) => {
  const str = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
};

/** Client-side mirror of tool summaries (stored messages keep only name + input). */
export function toolSummary(name: string, input: Record<string, unknown> = {}): string {
  switch (name) {
    case 'read_file':
      return `Read ${s(input.path)}`;
    case 'write_file':
      return `Write ${s(input.path)}`;
    case 'edit_file':
      return `Edit ${s(input.path)}`;
    case 'multi_edit':
      return `Edit ${s(input.path)} (${(input.edits as unknown[] | undefined)?.length ?? 0} changes)`;
    case 'apply_patch':
      return 'Apply patch';
    case 'list_dir':
      return `List ${s(input.path ?? '.')}`;
    case 'glob':
      return `Find ${s(input.pattern)}`;
    case 'grep':
      return `Search "${s(input.pattern, 40)}"`;
    case 'shell':
      return (input.description as string) || `$ ${s(input.command, 70)}`;
    case 'execute_code':
      return `Run ${s(input.language)}`;
    case 'web_search':
      return `Search the web: ${s(input.query, 50)}`;
    case 'web_fetch':
      return `Fetch ${s(input.url, 60)}`;
    case 'browser':
      return `Browser ${s(input.action)}${input.url ? ` ${s(input.url, 50)}` : ''}`;
    case 'memory':
      return input.action === 'add' ? `Remember: ${s(input.content, 50)}` : `Memory ${s(input.action)}`;
    case 'todo_write':
      return 'Update plan';
    case 'delegate':
      return `Delegate ${(input.tasks as unknown[] | undefined)?.length ?? 0} task(s)`;
    case 'skill_view':
      return `Load skill ${s(input.name)}`;
    case 'generate_image':
      return `Generate image: ${s(input.prompt, 50)}`;
    case 'cron_create':
      return `Schedule ${s(input.name ?? input.prompt, 40)}`;
    case 'send_message':
      return `Message ${s(input.to)}`;
    default:
      if (name.startsWith('mcp__')) return name.split('__').slice(1).join(' · ');
      return name.replace(/_/g, ' ');
  }
}

export function toolVerb(name: string): string {
  if (/read|view|list|glob|grep|search|fetch|recall/.test(name)) return 'read';
  if (/write|edit|patch|fs/.test(name)) return 'edit';
  if (/shell|execute|process/.test(name)) return 'run';
  return 'tool';
}
