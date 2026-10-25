# Architecture

Kronos is a TypeScript monorepo (npm workspaces, ESM, Node ≥ 20.19). Everything that makes the
agent *the agent* lives in `@kronos/core`; every surface is a thin client of one `Kronos`
runtime object.

```
                 ┌──────────────────────── surfaces ─────────────────────────┐
  terminal ──▶ kronos-agent (CLI/REPL)                                       │
  browser  ──▶ @kronos/web  ──HTTP/WS──┐                                     │
  desktop  ──▶ @kronos/desktop (Electron, embeds the gateway)                │
  chat apps ─▶ platform adapters ──────┤                                     │
  other apps ▶ /v1/chat/completions ───┤                                     │
  MCP clients ▶ kronos mcp serve ──────┤                                     │
  cron ───────────────────────────────┐│                                     │
                                      ▼▼                                     │
                      @kronos/gateway (Router, Hub, Terminal, Platforms)     │
                                      │                                      │
                                      ▼                                      │
 ┌──────────────────────────── @kronos/core: Kronos runtime ─────────────────┴──┐
 │ config + profiles · ProviderRegistry · ToolRegistry · PermissionPolicy · Hooks │
 │ Agent loop · Memory · SkillRegistry · SessionStore · Artifacts · CronScheduler │
 │ McpManager · TerminalBackend (local/docker/ssh) · BrowserManager · media       │
 └────────────────────────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Responsibility |
|---|---|
| `packages/core` (`@kronos/core`) | Types, config/profiles, providers, the agent loop, tools, safety, memory, skills, sessions, artifacts, cron, MCP client/server, media, messaging senders, the `Kronos` runtime. No HTTP server, no UI. |
| `packages/gateway` (`@kronos/gateway`) | `Gateway.start(rt)` — HTTP router (`/api/*`), WebSocket streaming (`/ws`), PTY terminal (`/ws/terminal`), OpenAI-compatible API (`/v1`), webhooks (`/hooks/*`), static UI, the `Hub` that runs/queues chats, and the messaging `PlatformManager`. |
| `packages/cli` (`kronos-agent`) | The `kronos` binary: REPL with streaming markdown renderer, subcommands, setup wizard, importers. |
| `apps/web` (`@kronos/web`) | React 19 + Vite UI. A tiny external store (`useSyncExternalStore`), a reconnecting WebSocket, i18n (en/tr), 8 themes. Served by the gateway. |
| `apps/desktop` (`@kronos/desktop`) | Electron shell: embeds the runtime + gateway on loopback with a per-launch token (or attaches to a running gateway), tray, menus, global shortcut, notifications, deep links, auto-update. |

## The runtime (`packages/core/src/runtime.ts`)

`Kronos.create({ home, profile, cwd, overrides })` loads config, creates the profile directory,
then wires up: `ProviderRegistry`, `ToolRegistry` (built-ins + MCP), `MemoryStore`,
`SkillRegistry`, `SessionStore` (SQLite via `node:sqlite` with FTS5, JSON fallback),
`ArtifactStore`, `CronScheduler`, `McpManager`, terminal backend and hooks. It exposes:

- `createSession()`, `agent(sessionId)` (live, cached `Agent` per session), `runHeadless()` (cron,
  API, MCP server), `deleteSession()`
- `expandInput()` — `/skill` and custom `/command $ARGUMENTS` expansion and `@file` mentions
- `updateConfig()` / `setConfig()` (writes YAML, hot-reloads), `soul` / `setSoul()`
- `sendMessage()` — delivery through a running platform adapter or a stateless sender
- `events` — a typed event bus (agent events, session updates, config changes, cron runs,
  artifacts) that the gateway fans out to WebSocket clients
- `track(promise)` + `close()` — background work (titles, memory extraction) finishes before
  shutdown

## The agent loop (`agent/agent.ts`)

```
user input ─▶ userPromptSubmit hooks ─▶ append to history
   ▲                                         │
   │                          ┌──────────────▼──────────────┐
   │                          │ provider.stream(request)    │  thinking / text / tool_use
   │                          │  (retries, fallback chain)  │  deltas → AgentEvents
   │                          └──────────────┬──────────────┘
   │                                         │ tool_use blocks
   │           ┌─────────────────────────────▼─────────────────────────────┐
   │           │ for each call: permission policy (mode, allow/deny rules, │
   │           │ dangerous-command check, protected paths) → ask the UI if │
   │           │ needed → preToolUse hooks → checkpoint files → execute    │
   │           │ (parallel-safe tools run concurrently) → postToolUse hooks │
   │           └─────────────────────────────┬─────────────────────────────┘
   │                                         │ tool_result blocks
   └──────────── loop until end_turn / max iterations / interrupt ◀────────┘
                then: stop hooks, auto-title, memory & skill nudges, usage log
```

Key properties:

- **Append-only history** and a **system prompt frozen per session** (identity, persona,
  environment, project context files, memory snapshot, skill index, toolset notes). Mid-session
  changes are delivered as notes on the next user turn, so provider prompt caches stay valid.
- **Streaming events** (`AgentEvent`): `run_start`, `turn_start`, `thinking_delta`,
  `text_delta`, `tool_call_start`, `tool_call_delta` (tool input as it is generated),
  `tool_call`, `tool_progress`, `tool_result`, `permission_request` / `permission_resolved`,
  `clarify_request` / `clarify_resolved`, `message`, `usage`, `compaction`, `todos`, `subagent`,
  `artifact`, `notice`, `title`, `run_end`.
- **Compaction** when the context window passes `agent.compaction.threshold`: older turns are
  summarised by the summary model; the last `keepRecentTurns` stay verbatim.
- **Interrupts** keep history valid: pending tool calls receive synthetic "interrupted" results.
- **Checkpoints**: files are snapshotted before the first write in a turn → `undo` restores
  them and truncates history; `retry` re-runs the last prompt.
- **Subagents** (`delegate`): each gets a fresh context, a typed role (general, explorer,
  researcher, coder, reviewer, planner, or a markdown-defined agent), its own tool subset and an
  optional cheaper model; they run concurrently up to `agent.subagents.maxConcurrent` and nest to
  `maxDepth`.

## Providers (`providers/`)

- `anthropic.ts` — official SDK (beta messages stream): adaptive thinking with summarised
  display, `effort`, eager tool-input streaming, automatic prompt caching, server-side refusal
  fallbacks and thinking-block binding controls when available, no sampling parameters for
  models that reject them, graceful retry without optional betas.
- `openai.ts` — fetch + SSE for every OpenAI-compatible API (OpenAI, OpenRouter, Gemini, Groq,
  DeepSeek, Mistral, xAI, NVIDIA, Nous, Together, Fireworks, Cerebras, Moonshot, Z.ai, Ollama,
  LM Studio, custom). Extracts inline `<tool_call>{…}</tool_call>` emitted by Hermes-style models.
- `demo.ts` — deterministic offline model that exercises real tools (used for first-run and
  for tests).
- `registry.ts` — `provider:model` references, aliases (`opus`, `sonnet`, `gpt`, `gemini`,
  `hermes`, `local`, …), `auto` selection by configured keys, retries with backoff for
  retryable errors and a fallback chain (`model.fallbacks`).
- `catalog.ts` — model metadata: context window, output limit, tool/vision support, pricing
  (for cost tracking).

## Tools (`tools/`)

33 built-in tools grouped into toolsets that can be toggled per profile:

| Toolset | Tools |
|---|---|
| files | `read_file`, `write_file`, `edit_file`, `multi_edit`, `apply_patch`, `list_dir`, `glob`, `grep`, `fs` |
| shell | `shell`, `process` (background processes) |
| code | `execute_code` (Python / JavaScript / Bash) |
| web · http · browser | `web_search`, `web_fetch`, `http_request`, `browser` |
| memory · sessions | `memory`, `session_search` |
| todo · clarify · core | `todo_write`, `ask_user`, `exit_plan_mode` |
| delegate · skills | `delegate`, `skills_list`, `skill_view`, `skill_manage` |
| cron | `cron_create`, `cron_list`, `cron_update` |
| image · vision · voice | `generate_image`, `view_image`, `text_to_speech` |
| artifacts · messaging | `artifact_create`, `send_message` |
| mcp | every tool of every connected MCP server, as `mcp__<server>__<tool>` |

Each `ToolDefinition` declares a JSON schema, a `risk` level (`read`, `write`, `execute`, `network`,
`external`), whether it is parallel-safe, a human summary for UIs, and `execute(input, ctx)`.
Tool output is truncated to `agent.toolOutputLimit` with a pointer to the full content.

## Safety (`safety/`)

`PermissionPolicy.check(tool, input)` combines: the session **mode** (`ask` asks for writes and
execution, `auto-edit` auto-approves file edits in the workspace, `yolo` approves everything
except what must always ask, `plan` refuses writes until `exit_plan_mode` is approved), **deny
rules** (always win), **allow rules** (`shell(npm test*)`, `write_file(src/**)`, `mcp__github__*`),
**dangerous command detection** (`rm -rf /`, `mkfs`, fork bombs, `curl … | sh`, force pushes,
disk writes…) per `safety.dangerousCommands`, **protected paths** and `workspaceOnly`.
Approvals can be "once", "always for this session" or "always" (persisted as an allow rule).
Secrets in tool output are redacted when `safety.redactSecrets` is on.

## Memory, skills, sessions

- **Memory** (`memory/store.ts`): `memories/MEMORY.md` and `memories/USER.md`, entries separated
  by `§`, each file with a character budget. The agent edits them with the `memory` tool
  (add / patch / remove / search / view). A snapshot is taken at session start (frozen prompt); the
  agent is nudged every `agent.nudges.memoryEvery` turns to save durable facts.
- **Skills** (`skills/registry.ts`): directories with `SKILL.md` from (in priority order)
  project `.kronos/skills`, user `~/.kronos/skills`, extra dirs, Claude-compatible dirs and the
  bundled `skills/`. Only names + descriptions go into the prompt; `skill_view` loads bodies and
  supporting files; `skill_manage` creates, patches, updates, deletes and installs from git.
  BM25 search ranks skills for a task. After many tool calls in a turn the agent is nudged to
  capture the procedure as a skill.
- **Sessions** (`sessions/store.ts`): sessions, messages (JSON parts), usage records and an FTS5
  index over message text. Child sessions record subagent runs. Without SQLite, an equivalent
  JSON-file store is used.

## Gateway (`packages/gateway`)

- **REST** (`api.ts`): status, doctor, config (get/patch/reset/export/import), keys (`.env`),
  providers/models, sessions (CRUD, undo, compact, fork, export, stop), search, chat, skills,
  toolsets, commands, agents, artifacts, files (list/read/write/upload), memory, soul, profiles,
  cron, MCP, platforms + pairing, usage/insights, voice, git.
- **WebSocket** `/ws`: clients `subscribe` to sessions and send `chat`, `stop`, `unqueue`,
  `permission`, `clarify`, `set_mode`, `set_model`; the server streams `agent` events, session
  updates, config changes, cron and platform status. The `Hub` serialises runs per session and
  queues follow-ups.
- **Terminal** `/ws/terminal`: a real PTY via a small Python `pty` bridge (resize over a side
  channel), falling back to `script` or pipes.
- **OpenAI-compatible** `/v1/models`, `/v1/chat/completions` (streaming and non-streaming): the
  last user message runs through a full Kronos agent turn with tools, memory and skills.
- **Auth**: a token (Bearer, `?token=`, or cookie) — required automatically when binding to a
  non-loopback address; CORS allow-list; webhooks verify their own secrets.
- **Platforms** (`platforms/`): Telegram (long polling), Discord (gateway WebSocket), Slack
  (Socket Mode), Matrix (`/sync`), Signal (signal-cli REST), WhatsApp (Cloud API webhook),
  generic webhook. Each maps a chat to a Kronos session, supports pairing, approvals, chat
  commands and voice-memo transcription, and chunks/format messages per platform. Outbound-only
  delivery also covers Home Assistant and email (SMTP).

## Data layout

```
~/.kronos/                     (KRONOS_HOME; the "default" profile)
  config.yaml                  user config (project overrides: <repo>/.kronos/config.yaml)
  .env                         API keys and secrets (never shown back in full)
  SOUL.md                      persona
  KRONOS.md                    global instructions loaded into every session
  memories/MEMORY.md, USER.md  long-term memory
  skills/                      user + agent-created skills
  agents/                      custom subagent definitions (*.md)
  commands/                    custom slash commands (*.md)
  sessions.db                  SQLite sessions, messages, usage, FTS index
  artifacts/                   artifact index + files
  cron/                        jobs.json + run history
  checkpoints/                 file snapshots for undo
  cache/, logs/, outputs/
  profiles/<name>/…            same layout per extra profile
  active_profile
```

## Testing

- `npm test` — vitest: utilities, providers' message conversion, the full agent loop against the
  demo model (tools, permissions, plan mode, memory across sessions, subagents, interrupts,
  compaction, session search, cron), SMTP delivery, and the gateway (REST, WebSocket chat
  streaming, auth, OpenAI-compatible API, PTY terminal).
- `npm run test:e2e` — boots a gateway on a temp home and drives the real UI in Chromium with
  Playwright (chat, tool cards, plans, every page, settings, palette, files, terminal), failing on
  any browser error.
