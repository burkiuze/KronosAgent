# heynavio.com — Navio, Kronos Agent and the Babo admin

One Vercel project, no build step, no npm dependencies.

| Path | What it is | Files |
| --- | --- | --- |
| `/` | Navio home page (Locket Research layout, Navio content) | `index.html`, `navio/` |
| `/kronosagent` | Kronos Agent site | `kronosagent/index.html`, `kronosagent/styles.css`, `kronosagent/main.js` |
| `/kronosagent/app` | Kronos app: sign-in first, then chat | `kronosagent/app/` |
| `/babo` | Admin panel: promo codes and stats | `babo/` |
| `/api/kronos/*` | `me`, `chat` (hosted models), `redeem` | `api/kronos/` |
| `/api/babo/*` | `session` (login), `codes` | `api/babo/` |

## How the app works

- **Sign-in** uses the Clerk production instance on `heynavio.com` (email + password or email code).
  Visitors can also continue without an account.
- **Your own API keys** (OpenRouter, OpenAI, Anthropic, Gemini or any OpenAI-compatible endpoint) are
  stored only in the browser and the browser calls the provider directly. Chats are kept in
  `localStorage` on the device.
- **Kronos models** run through OpenRouter on our key, each pinned to one provider with no fallback
  (see `api/_lib/plans.js`). They need a membership; guests and members without a plan see them locked.
- **Memberships**: Lite, Pro, Max (2× Pro) and Max 5 (5× Pro), as a daily token allowance that resets at
  00:00 UTC. Members get them by redeeming promo codes created in `/babo`.

## Data

Memberships, promo codes, redemptions and usage live in the Supabase project `navio`, in the private
`kronos` schema (`supabase/kronos.sql`). The API reaches it only through `public.kronos_*` functions that
check a shared secret, so the public anon key alone can do nothing. After applying the SQL, store the
secret once:

```sql
insert into kronos.settings (key, value) values ('rpc_secret', '<SUPABASE_RPC_SECRET>')
on conflict (key) do update set value = excluded.value;
```

## Environment variables (Vercel)

| Name | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Key used for Kronos models |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase REST endpoint |
| `SUPABASE_RPC_SECRET` | Shared secret for the `kronos_*` functions |
| `CLERK_ISSUER` | `https://clerk.heynavio.com` |
| `CLERK_AUTHORIZED_PARTIES`, `ALLOWED_ORIGINS` | `https://heynavio.com,https://www.heynavio.com` |
| `ADMIN_PASSWORD_HASH` | `scrypt$<salt>$<hash>` of the `/babo` password (never the password itself) |
| `ADMIN_SESSION_SECRET` | HMAC key for `/babo` session cookies |

To change the admin password, generate a new hash:

```bash
node -e 'const c=require("crypto"),s=c.randomBytes(16);console.log(`scrypt$${s.toString("base64url")}$${c.scryptSync(process.argv[1],s,32).toString("base64url")}`)' 'NEW-PASSWORD'
```

## Fonts

All fonts are self-hosted SIL OFL files in `assets/fonts/` (licenses in `assets/fonts/licenses/`), so pages
make no third-party font requests.

## Run locally

```bash
python3 -m http.server 8000
```

Static pages work locally. The API needs the Vercel environment, and Clerk production keys only work on
`heynavio.com`.
