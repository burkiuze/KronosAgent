import type { JSONSchema, ToolCallPart, ToolSpec } from '../types.js';
import { newId } from '../util/misc.js';

/**
 * Tool calling that survives weak models. Frontier models emit clean native tool calls; small,
 * old or free models often do not: arguments with trailing commas or single quotes, calls written
 * into the reply text in their own training format, near-miss tool names (`bash`, `str_replace`).
 * Everything here turns such output into proper calls, and gives models without native function
 * calling a text protocol to use instead.
 */

// ---------------------------------------------------------------------------------------------
// JSON repair

/** Parses `input` as JSON, repairing what models commonly get wrong. Returns undefined if hopeless. */
export function repairJson(input: string): unknown {
  let s = input.trim();
  const fence = /^```[\w-]*\s*\n?([\s\S]*?)\n?```\s*$/.exec(s);
  if (fence) s = (fence[1] as string).trim();
  try {
    return JSON.parse(s);
  } catch {
    /* repair below */
  }
  const start = s.search(/[{[]/);
  if (start < 0) return undefined;
  s = s.slice(start);
  let out = '';
  const stack: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quote) {
      if (escaped) {
        // \' is not a JSON escape
        out = ch === "'" ? `${out.slice(0, -1)}'` : out + ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === quote) {
        out += '"';
        quote = null;
      } else if (ch === '"') out += '\\"';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += '"';
    } else if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      out += ch;
    } else if (ch === '}' || ch === ']') {
      out = out.replace(/,\s*$/, '');
      stack.pop();
      out += ch;
      if (!stack.length) break; // ignore trailing chatter
    } else if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < s.length && /[\w$.-]/.test(s[j] as string)) j++;
      const word = s.slice(i, j);
      const literal: Record<string, string> = { true: 'true', True: 'true', false: 'false', False: 'false', null: 'null', None: 'null', undefined: 'null' };
      out += s.slice(j).trimStart().startsWith(':') ? JSON.stringify(word) : (literal[word] ?? JSON.stringify(word));
      i = j - 1;
    } else out += ch;
  }
  if (quote) out += '"';
  while (stack.length) out = `${out.replace(/,\s*$/, '').replace(/:\s*$/, ': null')}${stack.pop()}`;
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

/** Tool arguments from a model: an object, or `{ __raw }` when they cannot be read. */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return raw === undefined || raw === null ? {} : { value: raw };
  if (!raw.trim()) return {};
  let v = repairJson(raw);
  if (typeof v === 'string') v = repairJson(v); // double-encoded
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return { __raw: raw };
}

// ---------------------------------------------------------------------------------------------
// Tool names

const TOOL_ALIASES: Record<string, string[]> = {
  shell: ['bash', 'sh', 'zsh', 'terminal', 'run', 'runcommand', 'executecommand', 'exec', 'execute', 'command', 'runshell', 'shellcommand', 'cmd', 'runterminalcmd', 'powershell', 'executebash', 'bashcommand'],
  read_file: ['read', 'cat', 'view', 'open', 'openfile', 'viewfile', 'fileread', 'readfile', 'getfile', 'readfiles', 'readfilecontent', 'showfile'],
  write_file: ['write', 'create', 'createfile', 'savefile', 'filewrite', 'writefile', 'newfile', 'writetofile'],
  edit_file: ['edit', 'strreplace', 'strreplaceeditor', 'strreplacebasededittool', 'replace', 'replaceinfile', 'fileedit', 'modifyfile', 'updatefile', 'searchreplace', 'searchandreplace', 'applyedit', 'editfile'],
  list_dir: ['ls', 'list', 'listfiles', 'listdirectory', 'dir', 'directorylist', 'tree', 'listdir', 'listfolder'],
  grep: ['search', 'rg', 'ripgrep', 'searchfiles', 'grepsearch', 'findinfiles', 'codebasesearch', 'searchcode', 'searchincode'],
  glob: ['find', 'findfiles', 'filesearch', 'globsearch', 'findfile'],
  web_search: ['searchweb', 'google', 'websearch', 'internetsearch', 'bing', 'duckduckgo', 'searchinternet'],
  web_fetch: ['fetch', 'browse', 'openurl', 'curl', 'geturl', 'readurl', 'fetchurl', 'webfetch', 'visit', 'fetchpage'],
  todo_write: ['todo', 'todos', 'updateplan', 'plan', 'writetodos', 'todowrite', 'updatetodos', 'settodos'],
  apply_patch: ['patch', 'applydiff', 'applypatch', 'diff'],
  ask_user: ['ask', 'askquestion', 'askfollowupquestion', 'question', 'askuser'],
  memory: ['remember', 'savememory', 'memorize'],
  multi_edit: ['multiedit', 'edits', 'batchedit'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0] as number;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j] as number;
      dp[j] = Math.min((dp[j] as number) + 1, (dp[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length] as number;
}

/** The available tool a model meant by `name` (exact, case/punctuation-insensitive, known alias, or a close typo). */
export function resolveToolName(name: string, known: Iterable<string>): string | undefined {
  const list = [...known];
  if (list.includes(name)) return name;
  // "functions.read_file", "default_api:read_file", "tools/read_file"
  const bare = name.replace(/^(functions|function|tools|tool|default_api|api)[.:/]/i, '').trim();
  if (list.includes(bare)) return bare;
  const n = norm(bare);
  if (!n) return undefined;
  const byNorm = list.find((k) => norm(k) === n);
  if (byNorm) return byNorm;
  for (const [target, aliases] of Object.entries(TOOL_ALIASES)) if (aliases.includes(n) && list.includes(target)) return target;
  if (n.length >= 5) {
    const scored = list.map((k) => ({ k, d: editDistance(n, norm(k)) })).sort((a, b) => a.d - b.d);
    if (scored[0] && scored[0].d <= 2 && scored[1]?.d !== scored[0].d) return scored[0].k;
  }
  return undefined;
}

/** The closest tool names, for an "unknown tool" error. */
export function suggestTools(name: string, known: Iterable<string>, max = 3): string[] {
  const n = norm(name);
  return [...known]
    .map((k) => ({ k, d: editDistance(n, norm(k)) - (norm(k).includes(n) || n.includes(norm(k)) ? 3 : 0) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.k);
}

// ---------------------------------------------------------------------------------------------
// Tool calls written as text

interface Found {
  start: number;
  end: number;
  name: string;
  args: Record<string, unknown>;
}

function fromObject(j: unknown): { name: string; args: Record<string, unknown> }[] {
  if (Array.isArray(j)) return j.flatMap(fromObject);
  if (!j || typeof j !== 'object') return [];
  const o = j as Record<string, unknown>;
  const fn = (typeof o.function === 'object' && o.function ? o.function : undefined) as Record<string, unknown> | undefined;
  const name = [o.name, o.tool, o.tool_name, o.toolName, o.action, fn?.name, typeof o.function === 'string' ? o.function : undefined].find((x) => typeof x === 'string') as string | undefined;
  if (!name) return Array.isArray(o.tool_calls) ? fromObject(o.tool_calls) : [];
  const raw = o.arguments ?? o.parameters ?? o.args ?? o.input ?? o.tool_input ?? o.action_input ?? o.params ?? fn?.arguments ?? fn?.parameters;
  return [{ name, args: parseToolArgs(raw ?? {}) }];
}

/** `<k>v</k>` / `<parameter=k>v</parameter>` / `<parameter name="k">v</parameter>` children. */
function xmlParams(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const re = /<parameter(?:=|\s+name=)["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/parameter>|<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\3>/g;
  for (const m of body.matchAll(re)) {
    const key = (m[1] ?? m[3]) as string;
    const value = ((m[2] ?? m[4]) as string).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    args[key] = value;
  }
  return args;
}

/**
 * Finds tool calls a model wrote into its reply instead of (or without) native function calling:
 * Hermes/Qwen `<tool_call>{…}</tool_call>`, Qwen3-Coder / Llama `<function=name>…</function>`,
 * Llama `<|python_tag|>{…}`, Mistral `[TOOL_CALLS]`, `<invoke name="…">`, Cline-style
 * `<read_file><path>…</path></read_file>`, and fenced or bare JSON naming a tool. Only calls that
 * name one of the available tools count, so ordinary JSON or code in an answer is left alone.
 *
 * Tagged formats are always accepted. The ambiguous ones (fenced/bare JSON, tool-named XML tags)
 * only with `loose` (the text protocol) or when the reply is little more than the call itself — so
 * a capable model that merely shows an example in its answer does not trigger a tool.
 */
export function extractTextToolCalls(text: string, known: Iterable<string>, opts: { loose?: boolean; anyName?: boolean } = {}): { text: string; calls: ToolCallPart[] } {
  const names = [...known];
  if (!text || (!names.length && !opts.anyName)) return { text, calls: [] };
  const found: Found[] = [];
  const taken = (s: number, e: number) => found.some((f) => s < f.end && e > f.start);
  const add = (start: number, end: number, items: { name: string; args: Record<string, unknown> }[]) => {
    const ok = items.map((c) => ({ ...c, name: opts.anyName ? c.name : resolveToolName(c.name, names) })).filter((c): c is { name: string; args: Record<string, unknown> } => Boolean(c.name));
    if (!ok.length || taken(start, end)) return;
    found.push(...ok.map((c, i) => ({ start: i === 0 ? start : end, end, name: c.name, args: c.args })));
  };
  const scan = (re: RegExp, parse: (m: RegExpMatchArray) => { name: string; args: Record<string, unknown> }[]) => {
    for (const m of text.matchAll(re)) add(m.index as number, (m.index as number) + m[0].length, parse(m));
  };
  const parseBody = (body: string) => {
    const fn = /^\s*<function=([\w.:-]+)>([\s\S]*?)(?:<\/function>|$)/.exec(body);
    if (fn) return [{ name: fn[1] as string, args: /^\s*[{[]/.test(fn[2] as string) ? parseToolArgs(fn[2]) : xmlParams(fn[2] as string) }];
    return fromObject(repairJson(body));
  };

  scan(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (m) => parseBody(m[1] as string));
  scan(/<function=([\w.:-]+)>([\s\S]*?)(?:<\/function>|$)/g, (m) => [{ name: m[1] as string, args: /^\s*[{[]/.test(m[2] as string) ? parseToolArgs(m[2]) : xmlParams(m[2] as string) }]);
  scan(/<invoke\s+name=["']([\w.:-]+)["']\s*>([\s\S]*?)(?:<\/invoke>|$)/g, (m) => [{ name: m[1] as string, args: xmlParams(m[2] as string) }]);
  scan(/<\|python_tag\|>\s*([\s\S]*?)(?:<\|eom_id\|>|<\|eot_id\|>|$)/g, (m) => fromObject(repairJson(m[1] as string)));
  scan(/\[TOOL_CALLS\]\s*([\w.:-]+)\[ARGS\]\s*(\{[\s\S]*?\})(?=\s*(?:\[TOOL_CALLS\]|$))/g, (m) => [{ name: m[1] as string, args: parseToolArgs(m[2]) }]);
  scan(/\[TOOL_CALLS\]\s*(\[[\s\S]*\])/g, (m) => fromObject(repairJson(m[1] as string)));
  const tagged = found.length;
  scan(/```(?:json|tool_call|tool|tool_code|function_call|javascript|js)?\s*\n([\s\S]*?)\n?```/g, (m) => {
    const body = (m[1] as string).trim();
    return /^[{[]/.test(body) ? fromObject(repairJson(body)) : [];
  });
  // Cline / Roo style: <read_file><path>a.ts</path></read_file> — only for tool names, never arbitrary tags
  const tagNames = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (tagNames) scan(new RegExp(`<(${tagNames})>([\\s\\S]*?)</\\1>`, 'g'), (m) => [{ name: m[1] as string, args: xmlParams(m[2] as string) }]);
  // the whole reply is one JSON call
  const whole = text.trim();
  if (!found.length && /^[{[][\s\S]*[}\]]$/.test(whole)) add(text.indexOf(whole), text.indexOf(whole) + whole.length, fromObject(repairJson(whole)));

  if (!found.length) return { text, calls: [] };
  if (!tagged && !opts.loose) {
    // only loose matches: accept them when the reply is essentially just the call
    const covered = found.reduce((n, f) => n + (f.end - f.start), 0);
    if (text.trim().length - covered > 300) return { text, calls: [] };
  }
  found.sort((a, b) => a.start - b.start);
  let rest = '';
  let pos = 0;
  for (const f of found) {
    if (f.start >= pos) rest += text.slice(pos, f.start);
    pos = Math.max(pos, f.end);
  }
  rest += text.slice(pos);
  const calls = found.map((f) => ({ type: 'tool_call' as const, id: `call_${newId()}`, name: f.name, input: f.args }));
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), calls };
}

// ---------------------------------------------------------------------------------------------
// Text protocol for models without native function calling

function typeHint(s: JSONSchema | undefined): string {
  if (!s) return 'any';
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const t = Array.isArray(s.type) ? s.type.join(' | ') : (s.type as string | undefined);
  if (t === 'array') return `${typeHint(s.items as JSONSchema)}[]`;
  return t ?? 'any';
}

/** One line per argument: `name (type, required): description`. */
export function describeArgs(parameters: JSONSchema, maxDesc = 120): string[] {
  const props = (parameters.properties ?? {}) as Record<string, JSONSchema>;
  const required = new Set((parameters.required as string[] | undefined) ?? []);
  return Object.entries(props)
    .sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)))
    .map(([k, s]) => {
      const d = typeof s.description === 'string' ? s.description.replace(/\s+/g, ' ').trim() : '';
      return `${k} (${typeHint(s)}${required.has(k) ? ', required' : ''})${d ? `: ${d.length > maxDesc ? `${d.slice(0, maxDesc)}…` : d}` : ''}`;
    });
}

/** An example argument object with placeholders for the required arguments. */
export function exampleArgs(parameters: JSONSchema): Record<string, unknown> {
  const props = (parameters.properties ?? {}) as Record<string, JSONSchema>;
  const out: Record<string, unknown> = {};
  for (const k of (parameters.required as string[] | undefined) ?? []) {
    const t = typeHint(props[k]);
    out[k] = t.startsWith('"') ? JSON.parse(t.split(' | ')[0] as string) : t === 'integer' || t === 'number' ? 1 : t === 'boolean' ? true : t.endsWith('[]') ? [] : t === 'object' ? {} : `<${k}>`;
  }
  return out;
}

/** System prompt section that teaches the text tool protocol. */
export function textToolPrompt(tools: ToolSpec[]): string {
  const list = tools
    .map((t) => {
      const desc = t.description.replace(/\s+/g, ' ').trim();
      const args = describeArgs(t.parameters, 100);
      return `## ${t.name}\n${desc.length > 300 ? `${desc.slice(0, 300)}…` : desc}${args.length ? `\nArguments:\n${args.map((a) => `- ${a}`).join('\n')}` : ''}`;
    })
    .join('\n\n');
  return `# Calling tools
You call tools by writing a tool call block in your reply, exactly in this format:

<tool_call>
{"name": "read_file", "arguments": {"path": "src/app.ts"}}
</tool_call>

Rules:
- The block holds one JSON object with "name" (a tool below) and "arguments" (an object). Use double quotes and valid JSON; escape newlines inside strings as \\n.
- You may write several blocks to call several tools. Write nothing after your last block: stop and wait — the results come back in the next message inside <tool_result> tags.
- Never invent or predict a tool result. When the task is done, answer normally without any block.

# Tools

${list}`;
}

/** How an assistant tool call is replayed to a text-protocol model. */
export function renderToolCallText(name: string, input: Record<string, unknown>): string {
  return `<tool_call>\n${JSON.stringify({ name, arguments: input })}\n</tool_call>`;
}

/** How a tool result is replayed to a text-protocol model. */
export function renderToolResultText(name: string, content: string, isError?: boolean): string {
  return `<tool_result name="${name}"${isError ? ' error="true"' : ''}>\n${content}\n</tool_result>`;
}

/** Errors with which providers reject the `tools` parameter for a model that cannot call tools. */
export function isToolsUnsupportedError(message: string): boolean {
  return /does not support tools|doesn't support tools|tools? (?:use |calling )?(?:is |are )?not supported|no endpoints found that support tool|function calling is not (?:enabled|supported)|tool_choice.*not supported|unsupported parameter:? .?tools|does not support function/i.test(message);
}

// ---------------------------------------------------------------------------------------------
// <think> blocks inside the answer text (DeepSeek-R1, QwQ, many local reasoning models)

/** Streams text, routing `<think>…</think>` spans to thinking. Tags split across chunks are handled. */
export class ThinkSplitter {
  private inThink = false;
  private pending = '';
  private seenText = false;

  constructor(private readonly emit: (kind: 'text' | 'thinking', s: string) => void) {}

  push(chunk: string): void {
    let s = this.pending + chunk;
    this.pending = '';
    while (s) {
      const tag = this.inThink ? '</think>' : '<think>';
      const i = s.indexOf(tag);
      if (i >= 0) {
        this.out(s.slice(0, i));
        s = s.slice(i + tag.length);
        // only a leading <think> opens a block; later ones are just text the model wrote
        if (!this.inThink && this.seenText) {
          this.out(tag);
          continue;
        }
        this.inThink = !this.inThink;
        continue;
      }
      // keep a possible partial tag for the next chunk
      const keep = partialSuffix(s, tag);
      this.out(s.slice(0, s.length - keep));
      this.pending = s.slice(s.length - keep);
      return;
    }
  }

  flush(): void {
    if (this.pending) this.out(this.pending);
    this.pending = '';
  }

  private out(s: string): void {
    if (!s) return;
    if (this.inThink) this.emit('thinking', s);
    else {
      // the answer starts at its first visible character (not with the newlines after </think>)
      const t = this.seenText ? s : s.trimStart();
      if (!t) return;
      this.seenText = true;
      this.emit('text', t);
    }
  }
}

function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(s.length - n))) return n;
  return 0;
}
