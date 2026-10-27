import { json, readJson, sameOrigin } from "../_lib/http.js";
import { userFromRequest } from "../_lib/clerk.js";
import { rpc } from "../_lib/db.js";

export async function POST(req) {
  if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
  const user = await userFromRequest(req);
  if (!user) return json({ error: "signed_out" }, 401);
  const { code } = await readJson(req, 2048).catch(() => ({}));
  if (typeof code !== "string" || !/^[A-Za-z0-9-]{4,40}$/.test(code.trim())) return json({ ok: false, error: "invalid" }, 400);
  const result = await rpc("kronos_redeem", { p_user: user, p_code: code });
  return json(result, result.ok ? 200 : 400);
}
