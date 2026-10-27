import { randomBytes } from "node:crypto";
import { json, readJson, sameOrigin } from "../_lib/http.js";
import { rpc } from "../_lib/db.js";
import { isAdmin } from "../_lib/admin.js";
import { TIERS } from "../_lib/plans.js";

const guard = (req, write) => {
  if (write && !sameOrigin(req)) return json({ error: "forbidden" }, 403);
  if (!isAdmin(req)) return json({ error: "unauthorized" }, 401);
  return null;
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () => {
  const bytes = randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `KRONOS-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
};

export async function GET(req) {
  return guard(req, false) || json(await rpc("kronos_admin_overview"));
}

export async function POST(req) {
  const denied = guard(req, true);
  if (denied) return denied;
  const b = await readJson(req, 4096).catch(() => ({}));
  const code = (typeof b.code === "string" && b.code.trim() ? b.code : randomCode()).trim().toUpperCase();
  const days = Number(b.days);
  const maxUses = b.maxUses === null || b.maxUses === "" || b.maxUses === undefined ? null : Number(b.maxUses);
  const validUntil = b.validUntil ? new Date(b.validUntil) : null;

  if (!/^[A-Z0-9-]{4,40}$/.test(code)) return json({ error: "bad_code" }, 400);
  if (!TIERS[b.tier]) return json({ error: "bad_tier" }, 400);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return json({ error: "bad_days" }, 400);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000)) return json({ error: "bad_uses" }, 400);
  if (validUntil && Number.isNaN(validUntil.getTime())) return json({ error: "bad_date" }, 400);

  const row = await rpc("kronos_admin_create_code", {
    p_code: code,
    p_tier: b.tier,
    p_days: days,
    p_max_uses: maxUses,
    p_valid_until: validUntil ? validUntil.toISOString() : null,
    p_note: typeof b.note === "string" ? b.note.slice(0, 200) : "",
  });
  return row.error ? json(row, 409) : json(row, 201);
}

export async function PATCH(req) {
  const denied = guard(req, true);
  if (denied) return denied;
  const b = await readJson(req, 1024).catch(() => ({}));
  if (typeof b.code !== "string") return json({ error: "bad_code" }, 400);
  await rpc("kronos_admin_set_active", { p_code: b.code, p_active: Boolean(b.active) });
  return json({ ok: true });
}

export async function DELETE(req) {
  const denied = guard(req, true);
  if (denied) return denied;
  const b = await readJson(req, 1024).catch(() => ({}));
  if (typeof b.code !== "string") return json({ error: "bad_code" }, 400);
  await rpc("kronos_admin_delete_code", { p_code: b.code });
  return json({ ok: true });
}
