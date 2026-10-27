// Calls the public.kronos_* Postgres functions through PostgREST.
// Every call carries the shared RPC secret; see supabase/kronos.sql.
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;
const SECRET = process.env.SUPABASE_RPC_SECRET;

export async function rpc(fn, args = {}) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ p_secret: SECRET, ...args }),
  });
  if (!res.ok) throw new Error(`db ${fn} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
