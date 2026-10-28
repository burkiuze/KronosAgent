# Kronos account and Kronos Cloud

Kronos works without an account: connect your own API keys (Settings → Providers & API keys) or a
local model. A Kronos account adds **Kronos Cloud** — models served for members, with no keys to
manage.

## First start

The app opens with three choices: **Sign in**, **Create account**, or **Continue without an
account**. The choice is remembered. You can sign in later from Settings → Membership, or with
`kronos login` in a terminal.

## Signing in

Sign-in happens on heynavio.com in your browser:

1. Kronos opens `https://www.heynavio.com/kronosagent/connect` with a one-time state and a PKCE code
   challenge.
2. You sign in (or create an account) and choose **Connect**.
3. The browser returns to Kronos (`/api/account/callback` on the gateway, or a temporary listener
   for `kronos login`) with a one-time code.
4. Kronos trades the code, together with the verifier only it knows, for an app token. The token
   is stored in `~/.kronos/.env` as `KRONOS_CLOUD_TOKEN`; plan, usage and the model list are cached in
   `~/.kronos/account.json`.

A code that leaks is useless without the verifier, and a code is bound to the address that asked for
it. If Kronos runs on another machine than the browser, the connect page warns before linking it.
Connected apps are listed (and can be disconnected) on your account page at
heynavio.com/kronosagent/account.

## Kronos Cloud models

| Model | Ref | Provider |
|---|---|---|
| GLM 5.3 Flash | `cloud:glm-5.3-flash` | Open Inference |
| MiniMax M3.1 Flash | `cloud:minimax-m3.1-flash` | Nebius Token Factory |
| Nemotron 3.5 Super VL | `cloud:nemotron-3.5-super-vl` | Crusoe |
| DeepSeek V4.1 Flash 1017 | `cloud:deepseek-v4.1-flash-1017` | Wafer |

They appear in the model picker for everyone. Without an account or a membership they are greyed out
with a lock; choosing one opens Settings → Membership.

## Memberships

| Plan | Usage |
|---|---|
| Lite | half of Pro |
| Pro | the standard allowance |
| Max | 2× Pro |
| Max 5 | 5× Pro |

Usage is measured per 5-hour session and per week. Settings → Membership shows both meters and when
they reset. When an allowance is used up, Kronos says so and when it resets. It does not keep retrying,
and your own providers stay available.

**Promo codes** are redeemed in Settings → Membership, with `kronos redeem <code>`, or on the account
page. Redeeming the plan you already have extends it, and a different plan replaces it.

## Terminal

```bash
kronos login            # sign in in the browser
kronos login --sign-up  # create an account
kronos account          # plan, usage, models
kronos redeem CODE
kronos logout
```

## Settings

| Key | |
|---|---|
| `cloud.url` | another Kronos Cloud deployment (default `https://www.heynavio.com`, and a bare `https://heynavio.com` is read as www; env `KRONOS_CLOUD_URL`) |
