/**
 * Provider for one-shot completions on engine models: titles, summaries, compaction, safety
 * reviews and other side calls Kronos makes outside the main agent loop (which runs on the engine
 * itself, see turn.ts). Each call runs in a throwaway engine session with every engine tool off.
 */
import type { ChatRequest, ChatResponse, Message, ModelInfo, Provider, StreamEvent } from '../types.js';
import { messageText } from '../types.js';
import { ProviderError } from '../providers/errors.js';
import type { EngineClient, EngineModelRef } from './client.js';

function transcript(messages: Message[]): string {
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (turns.length === 1 && turns[0]!.role === 'user') return messageText(turns[0]!);
  return turns
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${messageText(m)}`)
    .filter((l) => l.trim().length > 12)
    .join('\n\n');
}

export class EngineProvider implements Provider {
  constructor(
    readonly id: string,
    private readonly client: () => EngineClient | undefined,
    private readonly modelRef: (m: ModelInfo) => EngineModelRef | undefined,
  ) {}

  async chat(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResponse> {
    const client = this.client();
    const ref = this.modelRef(req.model);
    if (!client || !ref) throw new ProviderError('The Kronos engine is not running, so this model is unavailable right now.', this.id, 503);
    const session = await client.createSession('Kronos background task');
    try {
      const tools = Object.fromEntries((await client.toolIds()).map((t) => [t, false]));
      const r = await client.prompt(session.id, { model: ref, system: req.system || undefined, tools, parts: [{ type: 'text', text: transcript(req.messages) || ' ' }] }, req.signal);
      if (r.info?.error) throw new ProviderError(r.info.error.data?.message ?? r.info.error.name ?? 'engine error', this.id, r.info.error.data?.statusCode);
      const text = (r.parts ?? []).filter((p) => p.type === 'text').map((p) => String(p.text ?? '')).join('');
      if (text) onEvent({ type: 'text', text });
      const t = r.info?.tokens ?? {};
      return {
        parts: text ? [{ type: 'text', text }] : [],
        stopReason: 'end_turn',
        usage: {
          inputTokens: Number(t.input) || 0,
          outputTokens: Number(t.output) || 0,
          reasoningTokens: Number(t.reasoning) || 0,
          cacheReadTokens: Number(t.cache?.read) || 0,
          cacheWriteTokens: Number(t.cache?.write) || 0,
          costUsd: Number(r.info?.cost) || 0,
        },
        model: req.model.ref,
      };
    } finally {
      void client.deleteSession(session.id);
    }
  }
}
