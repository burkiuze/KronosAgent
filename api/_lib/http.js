export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const ALLOWED = (process.env.ALLOWED_ORIGINS || "https://heynavio.com,https://www.heynavio.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Reject cross-site writes. Browsers always send Origin on POST.
export const sameOrigin = (req) => {
  const origin = req.headers.get("origin");
  return !origin || ALLOWED.includes(origin) || origin === new URL(req.url).origin;
};

export const readJson = async (req, limit = 512 * 1024) => {
  const text = await req.text();
  if (text.length > limit) throw Object.assign(new Error("too_large"), { status: 413 });
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw Object.assign(new Error("bad_json"), { status: 400 });
  }
};

export const clientIp = (req) =>
  (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
