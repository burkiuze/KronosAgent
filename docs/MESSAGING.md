# Messaging platforms

Kronos can live in your chat apps. Platform adapters run inside the **gateway** — the desktop
app (while it is open or in the tray), `kronos web`, `kronos gateway`, or the Docker image. Each
chat maps to its own Kronos session with the same memory, skills and tools as everywhere else.

Configure platforms in the app (**Messaging**), or in `config.yaml` under `platforms.<id>` with
secrets in `~/.kronos/.env`. Every platform accepts:

| Key | Description |
|---|---|
| `enabled` | Start the adapter with the gateway. |
| `allowedUsers` | User ids (or numbers/handles) that may talk to the agent. Empty → **pairing required**. |
| `homeChat` | Default destination for automations and `send_message` with target `home` (or send `/sethome` in a chat). |
| `mode` | Permission mode for runs started from this platform (default `auto-edit`: file edits are automatic, shell commands and other risky actions ask in the chat). |

## Pairing new users

When someone who isn't on the allow-list messages the bot, Kronos replies with a six-character
pairing code and ignores the message. Approve it from **Messaging → Pairing requests** in the
app or with `kronos pairing approve <CODE>`; the user is added to `allowedUsers`. Codes are
random, unambiguous (no 0/O/1/I) and expire with the gateway process.

## Chat commands

| Command | Effect |
|---|---|
| `/help`, `/start` | What Kronos can do here. |
| `/new`, `/reset` | Start a fresh session for this chat. |
| `/stop` | Interrupt the current run. |
| `/status` | Model, mode, tokens, cost and context usage. |
| `/model <ref>` | Switch the model for this chat. |
| `/mode ask\|auto-edit\|yolo\|plan` | Change the permission mode for this chat. |
| `/undo`, `/retry` | Undo the last turn's file changes / re-run the last prompt. |
| `/compact` | Summarise the conversation to free context. |
| `/sethome` | Make this chat the home for automations. |
| `/approve` (`yes`, `y`), `/always`, `/deny` (`no`, `n`) | Answer a pending permission request. |

Any skill or custom command also works (`/code-review`, `/daily-briefing`, …). Voice memos are
transcribed (Settings → Voice) and answered like text. Long replies are split at paragraph
boundaries and formatted for each platform.

## Telegram

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Messaging → Telegram → paste the token → enable. (CLI: `kronos keys set TELEGRAM_BOT_TOKEN`
   and `kronos config set platforms.telegram.enabled true`.)
3. Message your bot; approve the pairing code.

Uses long polling, so it works behind NAT without a public URL. In groups, Kronos answers when
its @name is mentioned or a `/command` is used.

## Discord

1. [Developer portal](https://discord.com/developers/applications) → New application → Bot →
   copy the token; enable the **Message Content** intent.
2. OAuth2 → URL generator → scopes `bot`, permissions *Send Messages*, *Read Message History*
   → invite it to your server.
3. Paste the token in Messaging → Discord. Optional: restrict `channels`, keep `mentionOnly` on
   for servers (DMs always work).

## Slack

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) → enable **Socket Mode**
   (creates an `xapp-` app token with `connections:write`).
2. OAuth scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`;
   subscribe to the `app_mention` and `message.im` events; install to the workspace (`xoxb-` token).
3. Paste both tokens in Messaging → Slack.

## Matrix

Create a dedicated account for the bot, get an access token (Element → Settings → Help &
About → Access token), and fill homeserver URL, user id and token. Invites are accepted
automatically; end-to-end encrypted rooms are not supported yet.

## Signal

Run [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) (Docker), register
or link a number, then set `apiUrl` and `number` in Messaging → Signal.

## WhatsApp (Cloud API)

1. Create a Meta app with the WhatsApp product; note the **phone number id**, a permanent
   **access token**, and the app's **App secret** (App settings → Basic).
2. Expose the gateway publicly over HTTPS (reverse proxy, Cloudflare Tunnel, Tailscale Funnel…)
   and set `gateway.publicUrl`.
3. Webhook URL: `<public url>/hooks/whatsapp`, verify token = `platforms.whatsapp.verifyToken`;
   subscribe to `messages`.
4. Set the **app secret** so Kronos verifies the `X-Hub-Signature-256` HMAC on every delivery —
   without it anyone who learns the URL could forge messages.

## Generic webhook (Shortcuts, n8n, Zapier, Home Assistant automations…)

Enable it and set a secret, then:

```bash
curl -X POST http://127.0.0.1:7777/hooks/webhook \
  -H 'X-Kronos-Secret: <secret>' -H 'content-type: application/json' \
  -d '{"text": "What is on my calendar today?", "chat": "shortcuts"}'
# → {"text": "…", "sessionId": "…"}
```

`chat` names the conversation (default `default`): calls with the same `chat` continue one
session, different values keep separate threads.

## Outbound-only: email and Home Assistant

- **Email**: `platforms.email.smtpUrl` = `smtps://user:app-password@smtp.example.com:465` (implicit
  TLS) or `smtp://…:587` (STARTTLS — required when credentials are set), plus `from` and a
  default `to`. Deliver with `email:you@example.com` or just `email`.
- **Home Assistant**: URL + long-lived token; deliver to `homeassistant:notify.mobile_app_phone`
  (any `notify.*` service).

## Delivering automations

Automations (cron jobs) can send their result anywhere:

```bash
kronos cron add "every weekday at 7:30" "Run the daily-briefing skill" --deliver telegram:<chat id>
kronos cron add "every 30 minutes" "Check server health; reply only if something is wrong" --deliver slack:C0123
kronos cron add "every friday at 17:00" "Summarise this week's commits" --deliver email:team@example.com
```

Or simply ask in any chat: *"every morning at 8 send me the weather and top AI news here"* —
Kronos creates the job with this chat as the destination.

## Using Kronos from other apps

- **OpenAI-compatible API**: base URL `http://127.0.0.1:7777/v1`, model `kronos`, API key = the
  gateway token. Works with any OpenAI client library, Open WebUI, LibreChat, Raycast, etc.
- **MCP server**: `kronos mcp serve` (stdio) exposes a `kronos_agent` tool to Claude Desktop,
  Cursor, Zed and other MCP clients.
