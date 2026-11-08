# Built-in engine (internal)

Kronos runs its agent on an embedded engine: the open-source [opencode](https://opencode.ai) CLI,
started in the background as a local server (`opencode serve`). The engine does the agent work —
model calls, tools, permissions, its own session history. Kronos is the shell around it: the UI and
theme, the Kronos skills, the conversation list, messaging, automations. The UI never names the
engine.

opencode is MIT-licensed and is installed from npm (`opencode-ai`) into the Kronos home; its license
ships with that package.

## Pieces

| File | Role |
|---|---|
| `packages/core/src/backends/opencode.ts` | `OpencodeManager`: installs the engine (npm first, official installer as fallback), starts `serve` on a free port and waits until it answers, copies Kronos skills into the engine, checks for and applies updates. |
| `packages/core/src/engine/client.ts` | `EngineClient`: the part of the server API Kronos uses (sessions, `prompt_async`, `/event` stream, permission replies, connected models). |
| `packages/core/src/engine/turn.ts` | `runEngineTurn`: runs one Kronos turn on the engine and translates its events into Kronos agent events and messages. |
| `packages/core/src/engine/provider.ts` | `EngineProvider`: one-shot completions (titles, summaries, safety reviews) on engine models. |
| `packages/core/src/providers/registry.ts` | `setEngineModels` / `engineModelRef`: which Kronos models run on the engine. |
| `packages/core/src/agent/agent.ts` | `Agent.run` hands the turn to the engine when the model runs there. |

## Models

While the engine serves, Kronos lists the models the engine can run (`GET /provider`, `connected`):

- the engine's hosted service, free models only → the **Free models** group (`free:<model>`);
- every other provider the user connected *in the engine* → its own group (`engine-<provider>:<model>`,
  labelled with the provider's name).

`model.default: auto` resolves to `free:big-pickle`. Providers connected in Kronos's own settings
(Settings → Providers & API keys) keep running on Kronos's native agent loop.

When the engine is not running (CLI, gateway, tests), the `free` provider falls back to a catalog
seed list and the service's OpenAI-compatible endpoint; the service's free tier only answers the
engine itself, so in practice free models need the engine.

## A turn

`Agent.run` saves the user message, then calls `runEngineTurn`, which:

1. continues the engine session stored in the Kronos session (`meta.engineSession`) or creates one;
2. subscribes to `/event`, then sends the prompt with `prompt_async` (identity and the user's
   instructions go in `system`; Kronos plan mode uses the engine's read-only `plan` agent);
3. maps events: text / reasoning deltas → `text_delta` / `thinking_delta`; tool parts →
   `tool_call_start`, `tool_call`, `tool_result`; `step-finish` → `usage` plus the step's assistant
   and tool messages (saved to the Kronos session); `permission.asked` → the Kronos permission prompt
   (respecting yolo / auto-edit) → `permission/<id>/reply`; `session.error` / `session.idle` → end;
4. on Stop, aborts the engine session.

## Skills

The engine reads skills from `$OPENCODE_CONFIG_DIR/skills/<name>/SKILL.md` (one level, no nested
folders). Before starting the server, the manager copies every Kronos skill (bundled + the user's
`~/.kronos/skills`) there flat by folder name, and removes ones it copied earlier that are gone.
`OPENCODE_CONFIG_DIR` is Kronos's own directory (`~/.kronos/opencode/config`); the user's normal
engine config (their providers, keys, permission rules) still loads.

## Updates

The engine's own auto-update is off (`OPENCODE_DISABLE_AUTOUPDATE=1`). The desktop app checks npm
for a newer `opencode-ai` after launch and asks the user before installing it (also under
*Help → Check for Engine Updates…*).

## Configuration

```yaml
opencode:
  enabled: true       # Free models provider + engine credential discovery
  autoInstall: false  # desktop overrides to true: install the engine when missing
  serve: false        # desktop overrides to true: run the engine server
  port: 4096          # preferred port; a free one is used when it is taken
```

## Testing

`packages/core/test/engine.test.ts` replays an event sequence recorded from the real engine against a
stand-in server (no engine binary needed). For an end-to-end check, install `opencode-ai` from npm,
point a custom OpenAI-compatible provider in the engine's config at a local fake model, and run a
Kronos turn with `opencode.serve: true`.
