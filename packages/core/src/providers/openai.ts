import type { ChatRequest, ChatResponse, Message, ModelInfo, Part, Provider, StopReason, StreamEvent, ToolCallPart, Usage } from '../types.js';
import { MissingCredentialsError, ProviderError, isRetryableStatus, parseRetryAfter } from './errors.js';
import { genericModel } from './catalog.js';
import { newId } from '../util/misc.js';

export interface OpenAICompatOptions {
  id: string;
  label?: string;
  baseUrl: string;
  apiKey?: string;
  keyRequired?: boolean;
  envKeys?: string[];
  headers?: Record<string, string>;
  /** 'openai' uses max_completion_tokens + reasoning_effort */
  flavor?: 'openai' | 'openrouter' | 'ollama' | 'generic';
}

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | { type: string; [k: string]: unknown }[];
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Any OpenAI-compatible chat completions endpoint: OpenAI, OpenRouter, Gemini,
 * Groq, DeepSeek, Mistral, xAI, NVIDIA NIM, Nous Portal, Together, Fireworks,
 * Cerebras, Ollama, LM Studio, vLLM, llama.cpp …
 */
export class OpenAICompatProvider implements Provider {
  readonly id: string;
  constructor(private readonly opts: OpenAICompatOptions) {
    this.id = opts.id;
  }

  private get baseUrl(): string {
    let url = this.opts.baseUrl.replace(/\/+$/, '');
    if ((this.opts.flavor === 'ollama' || /:(11434|1234)$/.test(url)) && !/\/v1$/.test(url)) url += '/v1';
    return url;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...this.opts.headers };
    const key = this.opts.apiKey || (this.opts.envKeys ?? []).map((k) => process.env[k]).find(Boolean);
    if (key) h.authorization = `Bearer ${key}`;
    else if (this.opts.keyRequired) throw new MissingCredentialsError(this.id, this.opts.envKeys ?? []);
    if (this.opts.flavor === 'openrouter') {
      h['HTTP-Referer'] = 'https://github.com/burkiuze/KronosAgent';
      h['X-Title'] = 'Kronos Agent';
    }
    return h;
  }

  private body(req: ChatRequest): Record<string, unknown> {
    const model = req.model;
    const body: Record<string, unknown> = {
      model: model.id,
      messages: toOpenAIMessages(req.system, req.messages, model.vision !== false),
      stream: true,
      stream_options: { include_usage: true },
    };
    const maxTokens = Math.min(req.maxTokens, model.maxOutput || req.maxTokens);
    if (this.opts.flavor === 'openai') body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: { type: 'object', ...t.parameters } },
      }));
      body.tool_choice = 'auto';
      if (this.opts.flavor === 'openai') body.parallel_tool_calls = true;
    }
    const reasoning = model.reasoning === 'openai' || model.reasoning === 'adaptive';
    if (reasoning && req.thinking !== false && req.effort) {
      const effort = req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort;
      if (this.opts.flavor === 'openrouter') body.reasoning = { effort };
      else if (this.opts.flavor === 'openai' || this.id === 'gemini' || this.id === 'xai' || this.id === 'groq') body.reasoning_effort = effort;
    }
    if (typeof req.temperature === 'number' && !reasoning && !model.noSampling) body.temperature = req.temperature;
    if (this.opts.flavor === 'openrouter') body.usage = { include: true };
    return body;
  }

  async chat(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.body(req)),
        signal: req.signal,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(`Could not reach ${this.opts.label ?? this.id} at ${this.baseUrl}: ${(e as Error).message}`, this.id, undefined, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        msg = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? text;
      } catch {
        /* not json */
      }
      throw new ProviderError(
        `${this.opts.label ?? this.id} error ${res.status}: ${msg.slice(0, 800)}`,
        this.id,
        res.status,
        isRetryableStatus(res.status),
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    return this.consume(res, req, onEvent);
  }

  private async consume(res: Response, req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResponse> {
    const ctype = res.headers.get('content-type') ?? '';
    let text = '';
    let thinking = '';
    let finish: string | null = null;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let servedModel = req.model.id;
    const calls = new Map<number, { id: string; name: string; args: string }>();

    const handleChunk = (j: Record<string, unknown>) => {
      if (typeof j.model === 'string') servedModel = j.model;
      const u = j.usage as Record<string, unknown> | undefined;
      if (u) {
        const details = (u.prompt_tokens_details ?? {}) as Record<string, number>;
        const outDetails = (u.completion_tokens_details ?? {}) as Record<string, number>;
        const cached = details.cached_tokens ?? 0;
        usage = {
          inputTokens: Math.max(0, Number(u.prompt_tokens ?? 0) - cached),
          outputTokens: Number(u.completion_tokens ?? 0),
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
          reasoningTokens: outDetails.reasoning_tokens ?? 0,
          costUsd: typeof u.cost === 'number' ? u.cost : undefined,
        };
      }
      const choices = (j.choices ?? []) as Record<string, unknown>[];
      const choice = choices[0];
      if (!choice) return;
      const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
      const r = (delta.reasoning_content ?? delta.reasoning ?? delta.thinking) as unknown;
      if (typeof r === 'string' && r) {
        thinking += r;
        onEvent({ type: 'thinking', text: r });
      }
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onEvent({ type: 'text', text: delta.content });
      }
      const tcs = delta.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined;
      for (const [k, tc] of (tcs ?? []).entries()) {
        const idx = tc.index ?? k;
        let cur = calls.get(idx);
        if (!cur) {
          cur = { id: tc.id || `call_${newId()}`, name: tc.function?.name ?? '', args: '' };
          calls.set(idx, cur);
          if (cur.name) onEvent({ type: 'tool_call_start', id: cur.id, name: cur.name });
        } else if (tc.function?.name && !cur.name) {
          cur.name = tc.function.name;
          onEvent({ type: 'tool_call_start', id: cur.id, name: cur.name });
        }
        const a = tc.function?.arguments;
        if (a) {
          cur.args += a;
          onEvent({ type: 'tool_call_delta', id: cur.id, partialJson: a });
        }
      }
      if (choice.finish_reason) finish = String(choice.finish_reason);
    };

    if (!ctype.includes('text/event-stream') && !ctype.includes('stream')) {
      // some servers ignore stream:true
      const j = (await res.json()) as Record<string, unknown>;
      handleChunk(j);
    } else {
      const reader = res.body?.getReader();
      if (!reader) throw new ProviderError('empty response body', this.id, res.status, true);
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // one pass over the chunk; the unparsed tail is kept once at the end
        let start = 0;
        let nl: number;
        while ((nl = buf.indexOf('\n', start)) >= 0) {
          const line = buf.slice(start, nl).trim();
          start = nl + 1;
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data) as Record<string, unknown>;
            if (j.error) {
              const err = j.error as { message?: string; code?: number };
              throw new ProviderError(`${this.id}: ${err.message ?? JSON.stringify(err)}`, this.id, err.code, isRetryableStatus(err.code));
            }
            handleChunk(j);
          } catch (e) {
            if (e instanceof ProviderError) throw e;
          }
        }
        if (start) buf = buf.slice(start);
      }
    }

    const parts: Part[] = [];
    if (thinking) parts.push({ type: 'thinking', text: thinking, provider: this.id, model: servedModel });
    const toolCalls: ToolCallPart[] = [];
    for (const c of [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
      if (!c.name) continue;
      toolCalls.push({ type: 'tool_call', id: c.id, name: c.name, input: parseArgs(c.args) });
    }
    // Hermes / Qwen style models sometimes emit tool calls inline as text.
    if (!toolCalls.length && /<tool_call>/.test(text)) {
      const extracted = extractInlineToolCalls(text);
      if (extracted.calls.length) {
        text = extracted.text;
        toolCalls.push(...extracted.calls);
      }
    }
    if (text) parts.push({ type: 'text', text });
    parts.push(...toolCalls);
    let stopReason: StopReason = toolCalls.length ? 'tool_use' : 'end_turn';
    if (finish === 'length') stopReason = 'max_tokens';
    if (finish === 'content_filter') stopReason = 'refusal';
    if (!usage.inputTokens && !usage.outputTokens) {
      // estimate when the server does not report usage
      usage.outputTokens = Math.ceil((text.length + thinking.length) / 4);
    }
    return { parts, stopReason, usage, model: servedModel };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) throw new ProviderError(`listing models failed (${res.status})`, this.id, res.status);
    const j = (await res.json()) as { data?: { id: string; context_length?: number; name?: string }[]; models?: { name: string }[] };
    const list = j.data ?? j.models?.map((m) => ({ id: m.name })) ?? [];
    return list.map((m) => {
      const info = genericModel(this.id, m.id);
      const extra = m as { context_length?: number; name?: string };
      if (extra.context_length) info.contextWindow = extra.context_length;
      if (extra.name) info.name = extra.name;
      return info;
    });
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? v : { value: v };
  } catch {
    // tolerate trailing garbage / double-encoded JSON
    const m = /\{[\s\S]*\}/.exec(raw);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fallthrough */
      }
    }
    return { __raw: raw };
  }
}

export function extractInlineToolCalls(text: string): { text: string; calls: ToolCallPart[] } {
  const calls: ToolCallPart[] = [];
  const cleaned = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_, body: string) => {
    try {
      const j = JSON.parse(body) as { name?: string; arguments?: unknown; parameters?: unknown };
      if (j.name) {
        const args = typeof j.arguments === 'string' ? parseArgs(j.arguments) : ((j.arguments ?? j.parameters ?? {}) as Record<string, unknown>);
        calls.push({ type: 'tool_call', id: `call_${newId()}`, name: j.name, input: args });
        return '';
      }
    } catch {
      /* leave text untouched */
    }
    return _;
  });
  return { text: cleaned.trim(), calls };
}

export function toOpenAIMessages(system: string, messages: Message[], vision: boolean): OAIMessage[] {
  const out: OAIMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'system') {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
      if (text) out.push({ role: 'user', content: `<system-reminder>\n${text}\n</system-reminder>` });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
      const calls = m.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
      if (!text && !calls.length) continue;
      const msg: OAIMessage = { role: 'assistant', content: text || null };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
      }
      out.push(msg);
      continue;
    }
    // user + tool roles
    const images: { type: string; image_url: { url: string } }[] = [];
    const userContent: { type: string; [k: string]: unknown }[] = [];
    for (const p of m.parts) {
      if (p.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: p.toolCallId, content: p.content || '(no output)' });
        if (vision) for (const img of p.images ?? []) images.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
      } else if (p.type === 'text' && p.text) userContent.push({ type: 'text', text: p.text });
      else if (p.type === 'image' && vision) userContent.push({ type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
      else if (p.type === 'file') userContent.push({ type: 'text', text: `<attached_file name="${p.name}">\n${p.text ?? '(binary file)'}\n</attached_file>` });
    }
    if (images.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...images] });
    if (userContent.length) {
      const onlyText = userContent.every((c) => c.type === 'text');
      out.push({ role: 'user', content: onlyText ? userContent.map((c) => c.text as string).join('\n') : userContent });
    }
  }
  return out;
}
