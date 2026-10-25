---
name: kronos-setup
description: Help the user configure Kronos itself — API keys and models, permission modes, messaging platforms (Telegram, Discord, Slack, WhatsApp, Signal, Matrix), the gateway and OpenAI-compatible API, profiles, voice, terminal backends (Docker/SSH), automations and importing from other agents. Use when the user asks how to set up or change anything about Kronos.
version: 1.0.0
category: meta
tags: [kronos, setup, configuration, telegram, models, gateway]
---

# Configuring Kronos

Prefer doing it for the user when the toolsets allow (editing `~/.kronos/config.yaml` /
`.env` via files), otherwise give exact steps for the surface they use.

| Want | Desktop / web app | CLI |
|---|---|---|
| Add an API key | Settings → Providers & API keys (pick a provider, paste the key, it is verified live) | `kronos keys set ANTHROPIC_API_KEY` |
| Pick a model | model chip in the composer, Settings → Model | `kronos model set <ref>` / `/model` |
| Fallback models | Settings → Model → Fallback models | `kronos config set model.fallbacks '["openai:gpt-5"]'` |
| Permission mode | mode chip (Ask / Auto-edit / YOLO / Plan) | `/mode`, `--yolo`, `--plan` |
| Telegram bot | Messaging → Telegram → paste BotFather token → enable | `kronos keys set TELEGRAM_BOT_TOKEN` + `kronos config set platforms.telegram.enabled true` |
| Approve a new chat user | Messaging → pairing requests | `kronos pairing approve <code>` |
| Run 24/7 | keep the desktop app in the tray | `kronos gateway` (systemd/launchd/Docker) |
| Use from other apps | Messaging → "Use Kronos from other apps" | base URL `http://127.0.0.1:7777/v1`, model `kronos` |
| Profiles (separate memory/skills) | person icon → Profiles | `kronos profile create work` |
| Voice | Settings → Voice | `kronos config set voice.stt openai` |
| Docker/SSH sandbox | Settings → Workspace → Terminal backend | `kronos config set terminal.backend docker` |
| Automations | Automations → New | `kronos cron add "every day at 8am" "…" --deliver telegram:<chat>` |
| Import from Hermes/OpenClaw/Claude Code/Codex | — | `kronos import hermes` (etc.) |
| Health check | Settings → About → Doctor | `kronos doctor` |

## Provider notes

- Anthropic (`ANTHROPIC_API_KEY`) — default `claude-opus-5-5`; prompt caching on by default.
- OpenAI, Google Gemini, OpenRouter (hundreds of models with one key), Groq, DeepSeek, Mistral,
  xAI, NVIDIA NIM, Nous Portal, Together, Fireworks, Cerebras, Moonshot, Z.ai.
- Local: Ollama (`ollama:llama3.3`), LM Studio, any OpenAI-compatible server via a custom
  provider (Settings → Providers & API keys → Custom endpoint).
- No key at all → offline demo model, so the UI and tools can be explored.

## Security defaults to explain

Gateway binds to 127.0.0.1; exposing it requires a token. Messaging users must be paired or
allow-listed. Dangerous shell commands always ask unless explicitly allowed. Secrets live in
`~/.kronos/.env`, never in chat.
