// Verifies Clerk session tokens (RS256) against the instance JWKS.
// No SDK and no secret key needed: the public keys come from the Frontend API.
const ISSUER = process.env.CLERK_ISSUER || "https://clerk.heynavio.com";
const PARTIES = (process.env.CLERK_AUTHORIZED_PARTIES || "https://heynavio.com,https://www.heynavio.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let jwks = null;
let jwksAt = 0;

async function getKey(kid) {
  if (!jwks || Date.now() - jwksAt > 3600_000 || !jwks.has(kid)) {
    const res = await fetch(`${ISSUER}/.well-known/jwks.json`);
    if (!res.ok) throw new Error("jwks");
    const { keys } = await res.json();
    jwks = new Map();
    for (const k of keys) {
      if (k.kty !== "RSA") continue;
      const key = await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      jwks.set(k.kid, key);
    }
    jwksAt = Date.now();
  }
  return jwks.get(kid);
}

const b64 = (s) => Buffer.from(s, "base64url");

// Returns the Clerk user id, or null when the request carries no valid session.
export async function userFromRequest(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64(parts[0]));
    const payload = JSON.parse(b64(parts[1]));
    if (header.alg !== "RS256") return null;
    const key = await getKey(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(parts[2]), Buffer.from(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== ISSUER) return null;
    if (typeof payload.exp !== "number" || payload.exp < now - 5) return null;
    if (typeof payload.nbf === "number" && payload.nbf > now + 5) return null;
    if (payload.azp && !PARTIES.includes(payload.azp)) return null;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
