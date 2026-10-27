import { json, readJson, sameOrigin } from "../_lib/http.js";
import { userFromRequest } from "../_lib/clerk.js";
import { rpc } from "../_lib/db.js";
import { TIERS, MODELS } from "../_lib/plans.js";

export const maxDuration = 300;

const MAX_MESSAGES = 200;
const MAX_CHARS = 400_000;
const MAX_OUTPUT = 16_384;

function cleanMessages(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_MESSAGES) return null;
  let chars = 0;
  const out = [];
  for (const m of list) {
    if (!m || !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string") return null;
    chars += m.content.length;
    out.push({ role: m.role, content: m.content });
  }
  return chars <= MAX_CHARS ? out : null;
}

export async function POST(req) {
  if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
  if (!process.env.OPENROUTER_API_KEY) return json({ error: "service_unavailable" }, 503);

  const user = await userFromRequest(req);
  if (!user) return json({ error: "signed_out" }, 401);

  let body;
  try {
    body = await readJson(req, 2 * 1024 * 1024);
  } catch (e) {
    return json({ error: e.message }, e.status || 400);
  }
  const model = MODELS[body.model];
  const messages = cleanMessages(body.messages);
  if (!model) return json({ error: "unknown_model" }, 400);
  if (!messages) return json({ error: "bad_messages" }, 400);

  const me = await rpc("kronos_me", { p_user: user });
  const tier = TIERS[me.tier];
  if (!tier) return json({ error: "no_membership" }, 402);
  if (Number(me.used_today) >= tier.dailyTokens) return json({ error: "limit_reached" }, 429);

  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: req.signal,
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": "https://heynavio.com/kronosagent/app",
      "x-title": "Kronos Agent",
    },
    body: JSON.stringify({
      model: model.slug,
      messages,
      stream: true,
      max_tokens: Math.min(Number(body.max_tokens) || 8192, MAX_OUTPUT),
      usage: { include: true },
      provider: { only: [model.provider], allow_fallbacks: false },
    }),
  }).catch(() => null);

  if (!upstream || !upstream.ok || !upstream.body) {
    const detail = upstream ? (await upstream.text()).slice(0, 300) : "network";
    console.error("openrouter", upstream?.status, detail);
    return json({ error: "upstream", status: upstream?.status || 0 }, 502);
  }

  // Pass the SSE stream straight through, watching for the final usage block.
  let tail = "";
  let tokens = 0;
  const decoder = new TextDecoder();
  const watch = new TransformStream({
    transform(chunk, ctrl) {
      ctrl.enqueue(chunk);
      tail += decoder.decode(chunk, { stream: true });
      const lines = tail.split("\n");
      tail = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ") || !line.includes('"usage"')) continue;
        try {
          const u = JSON.parse(line.slice(6)).usage;
          if (u) tokens = (u.prompt_tokens || 0) + (u.completion_tokens || 0) || u.total_tokens || tokens;
        } catch {}
      }
    },
    async flush() {
      // Bill a rough estimate if the stream ended before a usage block arrived.
      const billed = tokens || Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
      await rpc("kronos_add_usage", { p_user: user, p_tokens: billed }).catch((e) => console.error(e));
    },
  });

  return new Response(upstream.body.pipeThrough(watch), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
