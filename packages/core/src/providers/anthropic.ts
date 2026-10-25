import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ChatRequest, ChatResponse, Message, Part, Provider, StopReason, StreamEvent, ToolCallPart, Usage } from '../types.js';
import { MissingCredentialsError, ProviderError } from './errors.js';
import { logger } from '../util/log.js';

const log = logger('anthropic');

export interface AnthropicProviderOptions {
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  serverFallbacks?: boolean;
  dropMismatchedThinking?: boolean;
  promptCaching?: boolean;
  id?: string;
}

// The SDK is loaded on first use: it costs ~160 ms and several MB of heap at startup, which
// sessions that never talk to Claude should not pay.
type SDK = typeof Anthropic;
let sdkPromise: Promise<SDK> | undefined;
const loadSdk = (): Promise<SDK> => (sdkPromise ??= import('@anthropic-ai/sdk').then((m) => m.default));

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/**
 * Claude via the official Anthropic SDK (beta namespace for fallbacks and thinking
 * block-binding controls). The harness keeps conversations append-only, freezes the
 * system prompt and tool list per session, and replays thinking blocks verbatim.
 */
export class AnthropicProvider implements Provider {
  readonly id: string;
  private client?: Anthropic;
  /** set when the endpoint rejected an optional beta, so we stop sending it */
  private betasDisabled = new Set<string>();
  private probing = false;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.id = opts.id ?? 'anthropic';
  }

  private get firstParty(): boolean {
    return !this.opts.baseUrl || /api\.anthropic\.com/.test(this.opts.baseUrl);
  }

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    const apiKey = this.opts.apiKey || process.env.ANTHROPIC_API_KEY || undefined;
    const authToken = this.opts.authToken || process.env.ANTHROPIC_AUTH_TOKEN || undefined;
    if (!apiKey && !authToken) throw new MissingCredentialsError(this.id, ['ANTHROPIC_API_KEY']);
    const Anthropic = await loadSdk();
    this.client = new Anthropic({
      apiKey: apiKey ?? null,
      authToken: authToken ?? null,
      baseURL: this.opts.baseUrl || undefined,
      defaultHeaders: this.opts.headers,
      maxRetries: 3,
      timeout: 15 * 60 * 1000,
    });
    return this.client;
  }

  async chat(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResponse> {
    const Anthropic = await loadSdk();
    let attempt = 0;
    for (;;) {
      try {
        return await this.once(req, onEvent);
      } catch (err) {
        if (err instanceof Anthropic.APIUserAbortError) throw abort();
        if (err instanceof Anthropic.BadRequestError) {
          // An endpoint (proxy, gateway, older platform) may reject an optional beta feature.
          // Retry once without the optional features; keep them off only if that fixes it.
          const optional = [FALLBACK_BETA, BINDING_BETA].filter((b) => !this.betasDisabled.has(b));
          if (optional.length && !this.probing) {
            optional.forEach((b) => this.betasDisabled.add(b));
            this.probing = true;
            try {
              const res = await this.once(req, onEvent);
              log.warn(`optional betas disabled for this endpoint after a 400: ${err.message}`);
              return res;
            } catch (retryErr) {
              optional.forEach((b) => this.betasDisabled.delete(b));
              if (!(retryErr instanceof Anthropic.BadRequestError)) throw retryErr;
            } finally {
              this.probing = false;
            }
          }
          throw new ProviderError(err.message, this.id, 400, false);
        }
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
          throw new ProviderError(`Anthropic rejected the credentials: ${err.message}`, this.id, err.status, false);
        }
        if (err instanceof Anthropic.NotFoundError) {
          throw new ProviderError(`Model or endpoint not found: ${err.message}`, this.id, 404, false);
        }
        if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
          throw new ProviderError(err.message, this.id, err.status, true);
        }
        if (err instanceof Anthropic.APIConnectionError) {
          throw new ProviderError(`Connection error: ${err.message}`, this.id, undefined, true);
        }
        if (err instanceof Anthropic.APIError) {
          throw new ProviderError(err.message, this.id, err.status, (err.status ?? 0) >= 500);
        }
        if (err instanceof MissingCredentialsError) throw err;
        // A tool input streamed with eager_input_streaming that could not be parsed at all
        // surfaces as the SDK's base AnthropicError: re-issue the turn (bounded) — the
        // failed turn was never appended to history.
        if (attempt < 2 && err instanceof Anthropic.AnthropicError) {
          attempt += 1;
          onEvent({ type: 'notice', level: 'warn', text: 'Tool input was not valid JSON; re-issuing the turn.' });
          continue;
        }
        throw err;
      }
    }
  }

  private buildParams(req: ChatRequest): BetaMessageStreamParams {
    const model = req.model;
    const betas: string[] = [];
    const params: Record<string, unknown> = {
      model: model.id,
      max_tokens: Math.min(req.maxTokens, model.maxOutput || req.maxTokens),
      messages: toAnthropicMessages(req.messages, model.systemMessages === true),
    };

    const caching = this.opts.promptCaching !== false;
    if (req.system) {
      params.system = [{ type: 'text', text: req.system, ...(caching ? { cache_control: { type: 'ephemeral' } } : {}) }];
    }
    if (caching) params.cache_control = { type: 'ephemeral' };

    if (req.tools.length) {
      params.tools = req.tools.map(
        (t) =>
          ({
            name: t.name,
            description: t.description,
            input_schema: { type: 'object', ...t.parameters },
            eager_input_streaming: true,
          }) as BetaToolUnion,
      );
    }

    if (model.reasoning === 'adaptive') {
      const thinking: Record<string, unknown> = { type: 'adaptive', display: req.showThinking === false ? 'omitted' : 'summarized' };
      if (this.opts.dropMismatchedThinking !== false && !this.betasDisabled.has(BINDING_BETA)) {
        thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' };
        betas.push(BINDING_BETA);
      }
      params.thinking = thinking;
      if (req.effort) params.output_config = { effort: req.effort };
    } else if (model.reasoning === 'budget' && req.thinking !== false) {
      const max = params.max_tokens as number;
      const budget = Math.max(1024, Math.min(Math.floor(max * 0.5), effortBudget(req.effort)));
      if (budget < max) params.thinking = { type: 'enabled', budget_tokens: budget };
    }

    if (this.opts.serverFallbacks !== false && model.serverFallbacks && this.firstParty && !this.betasDisabled.has(FALLBACK_BETA)) {
      params.fallbacks = 'default';
      betas.push(FALLBACK_BETA);
    }
    if (betas.length) params.betas = betas;
    // Sampling parameters are intentionally never sent: current Claude models reject them.
    return params as unknown as BetaMessageStreamParams;
  }

  private async once(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResponse> {
    const client = await this.getClient();
    const params = this.buildParams(req);
    const stream = client.beta.messages.stream(params, { signal: req.signal });
    const toolNames = new Map<number, string>();
    for await (const ev of stream) {
      switch (ev.type) {
        case 'content_block_start': {
          const b = ev.content_block;
          if (b.type === 'tool_use') {
            toolNames.set(ev.index, b.id);
            onEvent({ type: 'tool_call_start', id: b.id, name: b.name });
          }
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta;
          if (d.type === 'text_delta') onEvent({ type: 'text', text: d.text });
          else if (d.type === 'thinking_delta') onEvent({ type: 'thinking', text: d.thinking });
          else if (d.type === 'input_json_delta') {
            const id = toolNames.get(ev.index);
            if (id) onEvent({ type: 'tool_call_delta', id, partialJson: d.partial_json });
          }
          break;
        }
        default:
          break;
      }
    }
    const final = await stream.finalMessage();
    const parts = fromAnthropicContent(final.content as BetaContentBlock[], this.id, final.model);
    const u = final.usage;
    const usage: Usage = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };
    const fellBack = final.content.some((b) => b.type === 'fallback');
    if (fellBack) onEvent({ type: 'notice', level: 'info', text: `Request was continued by fallback model ${final.model}.` });
    const stopDetails = (final as unknown as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
    return {
      parts,
      stopReason: mapStop(final.stop_reason),
      usage,
      model: final.model,
      refusal: final.stop_reason === 'refusal' ? { category: stopDetails?.category ?? null, explanation: stopDetails?.explanation ?? null } : undefined,
    };
  }

  async listModels() {
    const client = await this.getClient();
    const out = [];
    for await (const m of client.models.list({ limit: 100 })) {
      const info = m as unknown as { id: string; display_name?: string; max_input_tokens?: number; max_tokens?: number };
      out.push({
        ref: `${this.id}:${info.id}`,
        provider: this.id,
        id: info.id,
        name: info.display_name ?? info.id,
        contextWindow: info.max_input_tokens ?? 200_000,
        maxOutput: info.max_tokens ?? 64_000,
        tools: true,
        vision: true,
      });
    }
    return out;
  }
}

function abort(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

function effortBudget(effort?: string): number {
  switch (effort) {
    case 'low': return 2048;
    case 'medium': return 6000;
    case 'xhigh': return 24000;
    case 'max': return 48000;
    default: return 12000;
  }
}

function mapStop(s: string | null | undefined): StopReason {
  switch (s) {
    case 'tool_use': return 'tool_use';
    case 'max_tokens': return 'max_tokens';
    case 'refusal': return 'refusal';
    case 'pause_turn': return 'pause_turn';
    case 'stop_sequence': return 'stop_sequence';
    case 'model_context_window_exceeded': return 'context_window';
    default: return 'end_turn';
  }
}

function fromAnthropicContent(blocks: BetaContentBlock[], provider: string, model: string): Part[] {
  const parts: Part[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text': {
        const last = parts[parts.length - 1];
        if (last?.type === 'text') last.text += b.text;
        else parts.push({ type: 'text', text: b.text });
        break;
      }
      case 'thinking':
        parts.push({ type: 'thinking', text: b.thinking, signature: b.signature, provider, model });
        break;
      case 'redacted_thinking':
        parts.push({ type: 'thinking', text: '', redactedData: b.data, provider, model });
        break;
      case 'tool_use':
        parts.push({ type: 'tool_call', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
        break;
      default:
        // fallback / compaction / server-tool blocks are replayed verbatim
        parts.push({ type: 'raw', provider, model, block: b });
    }
  }
  return parts;
}

function imageBlock(p: { mediaType: string; data: string }): BetaContentBlockParam {
  return { type: 'image', source: { type: 'base64', media_type: p.mediaType as 'image/png', data: p.data } };
}

function userBlocks(parts: Part[]): BetaContentBlockParam[] {
  const out: BetaContentBlockParam[] = [];
  for (const p of parts) {
    if (p.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
    else if (p.type === 'image') out.push(imageBlock(p));
    else if (p.type === 'file') {
      out.push({ type: 'text', text: `<attached_file name="${p.name}"${p.path ? ` path="${p.path}"` : ''}>\n${p.text ?? '(binary file, use tools to inspect it)'}\n</attached_file>` });
    } else if (p.type === 'tool_result') {
      const content: ({ type: 'text'; text: string } | BetaContentBlockParam)[] = [{ type: 'text', text: p.content || '(no output)' }];
      for (const img of p.images ?? []) content.push(imageBlock(img));
      out.push({ type: 'tool_result', tool_use_id: p.toolCallId, content: content as never, is_error: p.isError || undefined });
    }
  }
  return out;
}

function assistantBlocks(parts: Part[]): BetaContentBlockParam[] {
  const out: BetaContentBlockParam[] = [];
  for (const p of parts) {
    if (p.type === 'thinking') {
      // replay thinking blocks unchanged; the API drops any the model cannot read
      if (p.redactedData) out.push({ type: 'redacted_thinking', data: p.redactedData });
      else if (p.signature && (p.provider ?? 'anthropic') === 'anthropic') out.push({ type: 'thinking', thinking: p.text, signature: p.signature });
    } else if (p.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
    else if (p.type === 'tool_call') out.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input });
    else if (p.type === 'raw' && p.provider === 'anthropic') out.push(p.block as BetaContentBlockParam);
  }
  return out;
}

export function toAnthropicMessages(messages: Message[], supportsSystemMessages: boolean): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  let pendingNotes: string[] = [];
  const pushUser = (blocks: BetaContentBlockParam[]) => {
    if (pendingNotes.length) {
      blocks = [...blocks, { type: 'text', text: pendingNotes.map((n) => `<system-reminder>\n${n}\n</system-reminder>`).join('\n') }];
      pendingNotes = [];
    }
    if (blocks.length) out.push({ role: 'user', content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'tool') {
      pushUser(userBlocks(m.parts));
    } else if (m.role === 'assistant') {
      const blocks = assistantBlocks(m.parts);
      if (!blocks.length) continue;
      if (out.length === 0) out.push({ role: 'user', content: [{ type: 'text', text: '(continuing the conversation)' }] });
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'system') {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
      if (!text) continue;
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user') {
        if (supportsSystemMessages) out.push({ role: 'system', content: text });
        else if (Array.isArray(prev.content)) prev.content.push({ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` });
        else pendingNotes.push(text);
      } else {
        pendingNotes.push(text);
      }
    }
  }
  if (pendingNotes.length) pushUser([]);
  return out;
}

/** Exposed for tests. */
export const _internal = { fromAnthropicContent, mapStop, assistantBlocks, userBlocks };
export type { ToolCallPart };
