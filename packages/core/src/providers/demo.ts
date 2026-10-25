import type { ChatRequest, ChatResponse, Message, Part, Provider, StreamEvent, ToolCallPart } from '../types.js';
import { newId, sleep } from '../util/misc.js';
import { estimateMessagesTokens, estimateTokens, firstLine, truncate } from '../util/text.js';

/**
 * Offline, deterministic "model" so Kronos is fully explorable without an API key
 * (and so the whole stack is testable end-to-end). It recognises a handful of
 * intents in English and Turkish and drives real tools to show the agent loop.
 */
export class DemoProvider implements Provider {
  readonly id = 'kronos';
  constructor(private readonly opts: { delayMs?: number } = {}) {}

  async chat(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResponse> {
    const delay = this.opts.delayMs ?? 8;
    const tools = new Set(req.tools.map((t) => t.name));
    const last = req.messages[req.messages.length - 1];
    let thinking = '';
    let text = '';
    const calls: ToolCallPart[] = [];

    if (/write concise titles/i.test(req.system)) {
      text = titleFor(lastUserText(req.messages));
    } else if (/extract durable facts/i.test(req.system)) {
      text = JSON.stringify(demoFacts(lastUserText(req.messages)));
    } else if (/summariz/i.test(req.system) && !req.tools.length) {
      text = summaryFor(req.messages);
    } else if (last?.role === 'system' && /have not run verify/.test(messagePlain(last)) && tools.has('verify')) {
      thinking = 'The harness asked me to verify the change before finishing.';
      text = 'Verifying the change.';
      calls.push(call('verify', {}));
    } else if (last && (last.role === 'tool' || last.parts.some((p) => p.type === 'tool_result'))) {
      thinking = 'The tools returned results. Summarize them clearly for the user.';
      text = afterTools(last, req.messages);
    } else {
      const userText = lastUserText(req.messages);
      const plan = route(userText, tools);
      thinking = plan.thinking;
      text = plan.text;
      calls.push(...plan.calls);
    }

    if (thinking && req.showThinking !== false) {
      for (const chunk of chunks(thinking, 18)) {
        if (req.signal?.aborted) break;
        onEvent({ type: 'thinking', text: chunk });
        await sleep(delay, req.signal).catch(() => undefined);
      }
    }
    for (const chunk of chunks(text, 6)) {
      if (req.signal?.aborted) {
        const e = new Error('Aborted');
        e.name = 'AbortError';
        throw e;
      }
      onEvent({ type: 'text', text: chunk });
      await sleep(delay, req.signal).catch(() => undefined);
    }
    for (const c of calls) {
      onEvent({ type: 'tool_call_start', id: c.id, name: c.name });
      onEvent({ type: 'tool_call_delta', id: c.id, partialJson: JSON.stringify(c.input) });
    }
    const parts: Part[] = [];
    if (thinking) parts.push({ type: 'thinking', text: thinking, provider: 'kronos', model: 'demo' });
    if (text) parts.push({ type: 'text', text });
    parts.push(...calls);
    return {
      parts,
      stopReason: calls.length ? 'tool_use' : 'end_turn',
      usage: {
        inputTokens: estimateMessagesTokens(req.messages) + estimateTokens(req.system),
        outputTokens: estimateTokens(text + thinking) + calls.length * 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: 'demo',
    };
  }
}

function* chunks(text: string, size: number): Generator<string> {
  const words = text.split(/(\s+)/);
  let buf = '';
  for (const w of words) {
    buf += w;
    if (buf.length >= size) {
      yield buf;
      buf = '';
    }
  }
  if (buf) yield buf;
}

function messagePlain(m: Message): string {
  return m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as Message;
    if (m.role !== 'user') continue;
    const t = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n').trim();
    if (t && !t.startsWith('<system-reminder>')) return t;
  }
  return '';
}

function call(name: string, input: Record<string, unknown>): ToolCallPart {
  return { type: 'tool_call', id: `toolu_demo_${newId()}`, name, input };
}

interface Plan {
  thinking: string;
  text: string;
  calls: ToolCallPart[];
}

const DEMO_NOTE =
  '\n\n> _Kronos is running in **offline demo mode**. Add an API key in **Settings → Providers & API keys** (or run `kronos setup`) to unlock a real model._';

function route(input: string, tools: Set<string>): Plan {
  const t = input.trim();
  const lower = t.toLowerCase();
  const has = (n: string) => tools.has(n);
  let m: RegExpExecArray | null;

  if (!t) return { thinking: '', text: 'Hi! I am Kronos. How can I help?', calls: [] };

  if (/\b(parallel|delegate|subagents?|paralel)\b/.test(lower) && has('delegate')) {
    return {
      thinking: 'Splitting the work across parallel subagents.',
      text: 'Delegating to two subagents in parallel.',
      calls: [call('delegate', { tasks: [{ task: 'List the files in the workspace and report the count', label: 'files' }, { task: 'Report the current date', label: 'date' }] })],
    };
  }
  if (/^(verify|check (it|the work)|run the (tests|checks)|doğrula)\b/.test(lower) && has('verify')) {
    return { thinking: "Run the project's own checks.", text: 'Running the project checks.', calls: [call('verify', {})] };
  }
  if ((m = /^\$\s+(.+)$/s.exec(t)) || (m = /^(?:run|execute|çalıştır)\s+[`"]?(.+?)[`"]?$/is.exec(t))) {
    if (has('shell')) return { thinking: `The user wants to run a shell command: ${m[1]}`, text: 'Running it now.', calls: [call('shell', { command: m[1] })] };
  }
  if (/\b(list|show)\b.*\bfiles\b|^ls\b|dosyalar(ı)? listele|dosyaları göster/.test(lower) && has('list_dir')) {
    return { thinking: 'Listing the workspace to see what is here.', text: 'Let me look at the workspace.', calls: [call('list_dir', { path: '.' })] };
  }
  if ((m = /\b(?:read|open|cat|oku)\s+(?:the\s+)?(?:file\s+)?([\w./~-]+\.[\w]+)/i.exec(t)) && has('read_file')) {
    return { thinking: `Reading ${m[1]}.`, text: `Reading \`${m[1]}\`.`, calls: [call('read_file', { path: m[1] })] };
  }
  if ((m = /\b(?:fetch|open|visit|aç)\s+(https?:\/\/\S+)/i.exec(t)) && has('web_fetch')) {
    return { thinking: `Fetching ${m[1]}.`, text: 'Fetching the page.', calls: [call('web_fetch', { url: m[1] })] };
  }
  if ((m = /\b(?:search(?: the web)?(?: for)?|google|ara(?:ştır)?)\s+(.+)/i.exec(t)) && has('web_search')) {
    return { thinking: `Searching the web for "${m[1]}".`, text: 'Searching the web.', calls: [call('web_search', { query: m[1] })] };
  }
  if ((m = /\b(?:remember|note that|hatırla|unutma)\s+(?:that\s+)?(.+)/i.exec(t)) && has('memory')) {
    return { thinking: 'The user wants me to remember something durable — saving it to memory.', text: 'Saving that to memory.', calls: [call('memory', { action: 'add', target: 'user', content: m[1] })] };
  }
  if ((m = /\b(?:create|write|make|oluştur)\s+(?:a\s+)?(?:new\s+)?file\s+(?:called\s+|named\s+)?([\w./-]+)/i.exec(t)) && has('write_file')) {
    const path = m[1] as string;
    return {
      thinking: `Creating ${path}.`,
      text: `Creating \`${path}\`.`,
      calls: [call('write_file', { path, content: `# ${path}\n\nCreated by Kronos Agent on ${new Date().toISOString().slice(0, 10)}.\n` })],
    };
  }
  if (/\b(plan|todo|to-do|yapılacak)\b/.test(lower) && has('todo_write')) {
    return {
      thinking: 'Breaking the request into a plan with trackable steps.',
      text: 'Here is a plan. I will track progress as I go.',
      calls: [
        call('todo_write', {
          todos: [
            { content: 'Understand the goal and constraints', status: 'completed' },
            { content: 'Explore the workspace', status: 'in_progress', activeForm: 'Exploring the workspace' },
            { content: 'Implement the change', status: 'pending' },
            { content: 'Verify and summarize', status: 'pending' },
          ],
        }),
      ],
    };
  }
  if (/\b(skills?|yetenek)\b/.test(lower) && has('skills_list')) {
    return { thinking: 'Listing installed skills.', text: 'These are the skills I can load on demand:', calls: [call('skills_list', {})] };
  }
  if (/\b(portrait|picture|image|drawing|resim|görsel|portre)\b/.test(lower) && has('generate_image')) {
    return { thinking: 'Generating an image.', text: 'Generating the image…', calls: [call('generate_image', { prompt: t })] };
  }
  if (/\b(every|daily|each morning|her gün|schedule|zamanla)\b/.test(lower) && has('cron_create')) {
    return {
      thinking: 'Creating a scheduled automation.',
      text: 'Scheduling it.',
      calls: [call('cron_create', { name: truncate(t, 40), schedule: 'every day at 9am', prompt: t })],
    };
  }
  if (/\b(date|time|saat|tarih)\b/.test(lower) && has('shell')) {
    return { thinking: 'Checking the system clock.', text: 'Checking the clock.', calls: [call('shell', { command: 'date' })] };
  }
  if (/^(merhaba|selam|günaydın|iyi akşamlar)/.test(lower)) {
    return {
      thinking: 'Türkçe bir selamlama — kendimi ve neler yapabildiğimi tanıtayım.',
      text:
        'Merhaba! Ben **Kronos**, otonom ajanınım. Dosyalarla çalışabilir, komut çalıştırabilir, web\'de arama yapıp sayfa okuyabilir, ' +
        'oturumlar arasında hatırlayabilir, otomasyon zamanlayabilir, işleri paralel alt ajanlara dağıtabilir ve Telegram, Discord, ' +
        'Slack gibi uygulamalardan seninle konuşabilirim.\n\nDene: `dosyaları listele`, `çalıştır git status`, `bir plan yap`, ' +
        '`her gün 9\'da bana hava durumunu gönder`.' +
        '\n\n> _Kronos şu an **çevrimdışı demo modunda**. Gerçek bir model için **Settings → Providers & API keys** bölümünden anahtar ekle (ya da `kronos setup` çalıştır)._',
      calls: [],
    };
  }
  if (/^(hi|hello|hey)\b/.test(lower)) {
    return {
      thinking: 'A greeting — introduce myself and what I can do.',
      text:
        'Hello! I am **Kronos**, your autonomous agent. I can work with files, run commands, browse and search the web, ' +
        'remember things across sessions, schedule automations, delegate to parallel subagents, and talk to you from Telegram, ' +
        'Discord, Slack and more.\n\nTry: `list files`, `run git status`, `search the web for kronos titan`, `make a plan`, ' +
        '`remember that I prefer TypeScript`, `create file notes.md`.' + DEMO_NOTE,
      calls: [],
    };
  }
  return {
    thinking: 'No tool needed for this one; answer directly.',
    text:
      `You said: “${truncate(t, 300)}”.\n\nIn demo mode I can show the full agent loop — try \`list files\`, \`run ls -la\`, ` +
      '`read README.md`, `search the web for …`, `make a plan`, `remember that …`, `create file hello.md`, ' +
      '`run these in parallel`.' + DEMO_NOTE,
    calls: [],
  };
}

function afterTools(toolMsg: Message, history: Message[]): string {
  const results = toolMsg.parts.filter((p) => p.type === 'tool_result') as Extract<Part, { type: 'tool_result' }>[];
  const lines: string[] = [];
  for (const r of results) {
    const body = r.content.trim();
    if (r.isError) {
      lines.push(`**${r.toolName}** reported a problem:\n\n\`\`\`\n${truncate(body, 600)}\n\`\`\``);
      continue;
    }
    switch (r.toolName) {
      case 'list_dir': {
        const entries = body.split('\n').filter((l) => l.trim());
        lines.push(`The workspace has **${entries.length}** entries:\n\n\`\`\`\n${truncate(entries.slice(0, 25).join('\n'), 1500)}\n\`\`\``);
        break;
      }
      case 'read_file':
        lines.push(`Here is the beginning of the file:\n\n\`\`\`\n${truncate(body, 1200)}\n\`\`\``);
        break;
      case 'shell':
        lines.push(`Command output:\n\n\`\`\`\n${truncate(body, 1500)}\n\`\`\``);
        break;
      case 'todo_write':
        lines.push('Plan created — you can follow progress in the task list.');
        break;
      case 'memory':
        lines.push('Saved. I will remember that in future sessions.');
        break;
      case 'write_file':
        lines.push(`Done — ${firstLine(body)}.`);
        break;
      case 'verify':
        lines.push(`Verification: ${firstLine(body)}`);
        break;
      default:
        lines.push(`**${r.toolName}**: ${truncate(body, 1200)}`);
    }
  }
  const asked = lastUserText(history);
  return `${lines.join('\n\n')}${asked ? '' : ''}${DEMO_NOTE}`;
}

/** Naive fact extraction so memory.autoExtract can be exercised offline. */
function demoFacts(prompt: string): { user: string[]; memory: string[] } {
  const said = /User said:\n([\s\S]*?)\n\nAssistant replied:/.exec(prompt)?.[1] ?? '';
  const known = prompt.split('User said:')[0] ?? '';
  const user: string[] = [];
  const name = /\b(?:my name is|i am|i'm|benim adım|adım)\s+([A-ZÇĞİÖŞÜ][\wçğıöşü]+)/i.exec(said);
  if (name && !known.includes(`name is ${name[1]}`)) user.push(`The user's name is ${name[1]}.`);
  const pref = /\bi (?:prefer|like|love|use)\s+([^.!?\n]{2,60})/i.exec(said);
  if (pref) user.push(`The user prefers ${pref[1]!.trim()}.`);
  return { user, memory: [] };
}

function titleFor(text: string): string {
  const words = text.replace(/[`*_#>]/g, '').split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'New conversation';
}

function summaryFor(messages: Message[]): string {
  const asks = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' '))
    .filter((t) => t && !t.startsWith('<'))
    .slice(-8);
  return `## Goal\n${asks[asks.length - 1] ?? 'n/a'}\n\n## Conversation so far\n${asks.map((a) => `- ${truncate(a, 160)}`).join('\n')}\n\n## Next steps\n- Continue from the latest request.`;
}
