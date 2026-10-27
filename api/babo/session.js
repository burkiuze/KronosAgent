import { json, readJson, sameOrigin, clientIp } from "../_lib/http.js";
import { rpc } from "../_lib/db.js";
import { checkPassword, sessionCookie, clearCookie, isAdmin } from "../_lib/admin.js";

const MAX_FAILURES = 5;

export async function GET(req) {
  return json({ admin: isAdmin(req) });
}

export async function POST(req) {
  if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
  const ip = clientIp(req);
  if ((await rpc("kronos_admin_gate", { p_ip: ip, p_failed: false })) >= MAX_FAILURES) {
    return json({ error: "too_many_attempts" }, 429);
  }
  const { password } = await readJson(req, 1024).catch(() => ({}));
  if (!checkPassword(password)) {
    await rpc("kronos_admin_gate", { p_ip: ip, p_failed: true });
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: "wrong_password" }, 401);
  }
  return json({ admin: true }, 200, { "set-cookie": sessionCookie() });
}

export async function DELETE(req) {
  if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
  return json({ admin: false }, 200, { "set-cookie": clearCookie() });
}
