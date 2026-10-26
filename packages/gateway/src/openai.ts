import type { ServerResponse } from 'node:http';
import type { AgentEvent, Kronos, Message } from '@kronos/core';
import { newId, catalogModels, NotConnectedError } from '@kronos/core';
import { HttpError, Router } from './http.js';
import type { Gateway } from './server.js';

interface OAIRequest {
  model?: string;
  messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] | null }[];
  stream?: boolean;
  user?: string;
  /** json_schema (validated, retried) or json_object */
  response_format?: { type: string; json_schema?: { name?: string; schema?: Record<string, unknown> } };
}

function contentText(c: OAIRequest['messages'][number]['content']): string {
  if (!c) return '';
  if (typeof c === 'string') return c;
  return c.map((p) => p.text ?? '').join('\n');
}

function imagesOf(c: OAIRequest['messages'][number]['content']) {
  if (!c || typeof c === 'string') return [];
  return c
    .filter((p) => p.type === 'image_url' && p.image_url?.url.startsWith('data:'))
    .map((p) => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(p.image_url?.url ?? '');
      return { type: 'image' as const, mediaType: m?.[1] ?? 'image/png', data: m?.[2] ?? '' };
    });
}

/**
 * OpenAI-compatible endpoint so any OpenAI client (Open WebUI, LibreChat, Continue, scripts)
 * can use Kronos — with all of its tools, memory and skills — as if it were a model.
 * model: "kronos" (default model) or "kronos/<provider:model>".
 * Conversation continuity: pass `user` or the X-Kronos-Session header.
 */
export function buildOpenAIRoutes(gw: Gateway): Router {
  const r = new Router();
  const rt = (): Kronos => gw.rt;

  r.get('/v1/models', () => {
    const created = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: [
        { id: 'kronos', object: 'model', created, owned_by: 'kronos' },
        ...catalogModels()
          .filter((m) => rt().providers.isConfigured(m.provider))
          .map((m) => ({ id: `kronos/${m.ref}`, object: 'model', created, owned_by: m.provider })),
      ],
    };
  });

  r.post('/v1/chat/completions', async (req, res) => {
    if (!rt().config.gateway.openaiApi) throw new HttpError(404, 'OpenAI-compatible API is disabled (gateway.openaiApi)');
    const body = await req.body<OAIRequest>();
    if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, 'messages is required');
    const k = rt();
    const modelRef = body.model && body.model.startsWith('kronos/') ? body.model.slice(7) : undefined;
    const sessionKey = String(req.headers['x-kronos-session'] ?? body.user ?? '');
    let sessionId: string | undefined;
    if (sessionKey) {
      const id = `api_${sessionKey.replace(/[^\w-]/g, '_').slice(0, 60)}`;
      sessionId = k.sessions.get(id) ? id : k.createSession({ id, source: 'api', title: `API · ${sessionKey}` }).id;
    }
    const last = [...body.messages].reverse().find((m) => m.role === 'user');
    let prompt = contentText(last?.content ?? '');
    const system = body.messages.filter((m) => m.role === 'system').map((m) => contentText(m.content)).join('\n');
    if (!sessionId || k.sessions.messages(sessionId).length === 0) {
      // stateless clients resend history: include earlier turns as context
      const earlier = body.messages.slice(0, body.messages.lastIndexOf(last as OAIRequest['messages'][number])).filter((m) => m.role !== 'system');
      if (earlier.length) prompt = `<conversation_so_far>\n${earlier.map((m) => `${m.role.toUpperCase()}: ${contentText(m.content)}`).join('\n\n')}\n</conversation_so_far>\n\n${prompt}`;
    }
    if (system) prompt = `<client_instructions>\n${system}\n</client_instructions>\n\n${prompt}`;
    const ready = k.providers.readiness(modelRef);
    if (!ready.ok) throw new NotConnectedError(ready.provider);
    const id = `chatcmpl-${newId()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model ?? 'kronos';

    const rf = body.response_format;
    const outputSchema = rf?.type === 'json_schema' && rf.json_schema?.schema ? rf.json_schema.schema : rf?.type === 'json_object' ? { type: 'object' } : undefined;
    if (outputSchema && body.stream) throw new HttpError(400, 'response_format with stream is not supported; use stream: false');
    if (!body.stream) {
      const result = (await k.runHeadless({ text: prompt, images: imagesOf(last?.content ?? null) }, { sessionId, model: modelRef, source: 'api', outputSchema })) as Awaited<ReturnType<typeof k.runHeadless>> & { output?: unknown; schemaErrors?: string[] };
      if (outputSchema && result.output === undefined) throw new HttpError(422, `the answer did not match response_format: ${(result.schemaErrors ?? []).join('; ')}`);
      if (outputSchema) result.text = JSON.stringify(result.output);
      return {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text || result.error || '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: result.usage.inputTokens + result.usage.cacheReadTokens, completion_tokens: result.usage.outputTokens, total_tokens: result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.outputTokens },
      };
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant' });
    const ctl = new AbortController();
    req.raw.on('close', () => ctl.abort());
    let lastWasTool = false;
    const onEvent = (e: AgentEvent) => {
      if (e.type === 'text_delta') {
        if (lastWasTool) chunk({ content: '\n\n' });
        lastWasTool = false;
        chunk({ content: e.text });
      } else if (e.type === 'thinking_delta') chunk({ reasoning_content: e.text });
      else if (e.type === 'tool_call') {
        chunk({ reasoning_content: `\n[${e.summary}]\n` });
        lastWasTool = true;
      }
    };
    try {
      await k.runHeadless({ text: prompt, images: imagesOf(last?.content ?? null) }, { sessionId, model: modelRef, source: 'api', onEvent, signal: ctl.signal });
    } catch (e) {
      chunk({ content: `\n[error] ${(e as Error).message}` });
    }
    chunk({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
    return undefined;
  });

  return r;
}

export type { Message, ServerResponse };
