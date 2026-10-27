import { scryptSync, timingSafeEqual, createHmac, randomBytes } from "node:crypto";

// ADMIN_PASSWORD_HASH = "scrypt$<salt b64url>$<hash b64url>" (N=16384, r=8, p=1, 32 bytes)
export function checkPassword(password) {
  const [scheme, salt, hash] = (process.env.ADMIN_PASSWORD_HASH || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash || typeof password !== "string" || password.length > 200) return false;
  const want = Buffer.from(hash, "base64url");
  const got = scryptSync(password, Buffer.from(salt, "base64url"), want.length);
  return timingSafeEqual(want, got);
}

const SECRET = () => process.env.ADMIN_SESSION_SECRET || "";
const sign = (data) => createHmac("sha256", SECRET()).update(data).digest("base64url");
const COOKIE = "babo_session";
const TTL = 8 * 3600;

export function sessionCookie() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + TTL, n: randomBytes(8).toString("hex") })).toString("base64url");
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/api/babo; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/api/babo; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function isAdmin(req) {
  if (!SECRET()) return false;
  const raw = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!payload || !sig) return false;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url")).exp > Date.now() / 1000;
  } catch {
    return false;
  }
}
