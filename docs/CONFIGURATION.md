# Configuration

Kronos reads, in increasing priority:

1. built-in defaults,
2. `~/.kronos/config.yaml` (or `~/.kronos/profiles/<name>/config.yaml` for a profile),
3. `<project>/.kronos/config.yaml` — **only** the project-safe keys `model`, `agent` and
   `toolsets` (a repository can't change your safety rules, keys or gateway),
4. command-line flags (`--model`, `--mode`, `--cwd`, `--profile`).

Every key can be edited in the app (**Settings**, searchable), with `kronos config set <key>
<value>`, or by hand (`kronos config edit`). Values may reference environment variables:
`${NAME}` or `${NAME:-default}`. Secrets belong in `~/.kronos/.env` (Settings → Providers & API keys or
`kronos keys set NAME`), which is loaded automatically and never displayed in full.

```bash
kronos config get model            # print a section (secrets masked)
kronos config set model.default anthropic:claude-opus-5-5
kronos config set safety.allow '["shell(npm test*)", "shell(git status)"]'
kronos config path                 # where the file lives
```

## Model

| Key | Default | Description |
|---|---|---|
| `model.default` | `auto` | `provider:model` or an alias (`opus`, `sonnet`, `haiku`, `fable`, `gpt`, `gemini`, `hermes`, `grok`, `deepseek`, `kimi`, `local`, `demo`). `auto` picks the best configured provider; with none connected, chats are refused with a "connect a provider" prompt (the demo model is never picked automatically). |
| `model.fallbacks` | `[]` | Tried in order when the primary fails with a non-retryable or exhausted error. |
| `model.effort` | `medium` | `low` · `medium` (recommended) · `high` · `xhigh` · `max` · `codemaster` — reasoning effort; Codemaster = max effort plus a plan → parallel exploration → tests → independent review workflow. |
| `model.toolMode` | `auto` | `native` function calling, `text` (tools described in the prompt and called as `<tool_call>` text — for models without function calling), or `auto`: native, switching a model to text when its provider rejects tools. |
| `model.thinking` / `model.showThinking` | `true` / `true` | Extended thinking, and streaming its summaries to the UI. |
| `model.maxOutputTokens` | `64000` | Upper bound per response (clamped to the model's limit). |
| `model.temperature` | `null` | Only sent to models that accept sampling parameters. |
| `model.subagent` / `model.summary` / `model.vision` | `null` | Optional cheaper/specialised models for subagents, compaction & titles, and image understanding. |

### Providers

`providers.<id>` accepts `apiKey`, `baseUrl`, `headers`, `models`, `enabled`. Built-in ids:
`anthropic`, `openai`, `openrouter`, `gemini`, `groq`, `deepseek`, `mistral`, `xai`, `nvidia`,
`together`, `fireworks`, `cerebras`, `nous`, `moonshot`, `zai`, `ollama`, `lmstudio`.
Anthropic extras: `promptCaching` (default on), `serverFallbacks`, `dropMismatchedThinking`.

Custom OpenAI- (or Anthropic-) compatible endpoints:

```yaml
customProviders:
  - id: vllm
    label: Office GPU box
    baseUrl: http://10.0.0.5:8000/v1
    apiKey: ${VLLM_KEY}
    models: [qwen3-coder-480b]
    api: openai          # or anthropic
```

Then use `vllm:qwen3-coder-480b` anywhere a model is accepted.

**Small, local and free models.** Kronos adapts on its own (lean mode, text tool protocol, call
repair — see `model.toolMode` and `agent.lean`), but give local servers enough context: Ollama
serves a small window by default, which silently cuts off the start of the prompt. Start it with
`OLLAMA_CONTEXT_LENGTH=32768 ollama serve` (or set `num_ctx` in a Modelfile); in LM Studio, raise
the context length when loading the model.

## Agent

| Key | Default | Description |
|---|---|---|
| `agent.name` | `Kronos` | How the agent refers to itself. |
| `agent.personality` | `default` | `default`, `concise`, `mentor`, `engineer`, `creative`, `friendly`, `executive` (plus `SOUL.md`). |
| `agent.instructions` | `""` | Extra standing instructions for every session. |
| `agent.language` | `auto` | Reply language; `auto` mirrors the user. |
| `agent.maxIterations` | `120` | Tool-use iterations per run. |
| `agent.parallelTools` | `true` | Run parallel-safe tool calls concurrently. |
| `agent.autoTitle` | `true` | Title new sessions automatically. |
| `agent.toolOutputLimit` | `40000` | Characters of tool output kept in context. |
| `agent.compaction` | `{enabled: true, threshold: 0.8, keepRecentTurns: 2, clearToolResults: true, keepToolResults: 8}` | Past `threshold` of the context window: first clear the bodies of tool outputs older than the last `keepToolResults`; if that is not enough, summarise everything before the last `keepRecentTurns` user turns. Replaced messages are archived (searchable, visible under "Show earlier messages"). |
| `agent.subagents` | `{maxConcurrent: 4, maxDepth: 2, maxIterations: 60}` | Delegation limits. |
| `agent.nudges` | `{memoryEvery: 12, skillAfterToolCalls: 18}` | When to remind the agent to save memories / capture a skill. |
| `agent.lean` | `auto` | `auto` · `on` · `off` — lean mode for small models: core tools only, short tool descriptions, a compact prompt (~70% less fixed context). `auto` = context windows up to 32k tokens. |
| `agent.editDiagnostics` | `true` | Parse files right after write/edit/patch (TS/JS, JSON, YAML, Python) and report syntax errors in the same tool result. |
| `agent.verifyBeforeFinish` | `true` | If a run changed files and never ran `verify` afterwards (and the project has checks), ask for one verification turn before finishing. |
| `agent.budget` | `{maxTokens: 0, maxCostUsd: 0, maxMinutes: 0}` | Per-run limits (0 = none). A run that reaches one stops cleanly (`stopReason: budget`) and can be continued. |

## Toolsets

`toolsets.enabled` / `toolsets.disabled` — any of `files`, `shell`, `web`, `browser`, `code`,
`memory`, `sessions`, `todo`, `clarify`, `delegate`, `skills`, `cron`, `image`, `vision`,
`voice`, `artifacts`, `messaging`, `http`, `mcp`. Disabled toolsets are removed from the model's
tool list entirely.

## Terminal

| Key | Default | Description |
|---|---|---|
| `terminal.backend` | `local` | `local`, `docker` (isolated container with the workspace mounted) or `ssh`. |
| `terminal.cwd` | `""` | Default working directory (empty = where Kronos was started). |
| `terminal.timeoutSec` | `180` | Default command timeout (background processes are exempt). |
| `terminal.docker` | `{image: node:22-bookworm, workdir: /workspace, extraArgs: [], network: true}` | Docker backend settings. |
| `terminal.ssh` | `{host: ""}` | `host`, `user`, `port`, `key`, `workdir`. |

## Safety

| Key | Default | Description |
|---|---|---|
| `safety.mode` | `ask` | `ask`, `auto-edit`, `yolo` or `plan`. |
| `safety.allow` / `safety.deny` | `[]` | Rules like `shell(git *)`, `write_file(src/**)`, `web_fetch`, `mcp__github__*`. Deny wins. |
| `safety.dangerousCommands` | `ask` | `ask`, `block` or `allow` for destructive shell patterns. |
| `safety.workspaceOnly` | `false` | Refuse file writes outside the workspace. |
| `safety.protectedPaths` | `~/.ssh/**`, `~/.aws/credentials`, `~/.kronos/.env`, `/etc/shadow` | Always ask before touching these. |
| `safety.redactSecrets` | `true` | Mask API keys/tokens in tool output. |
| `safety.checkpoints` | `true` | Snapshot files before edits (enables undo). |

## Hooks

Shell commands run at lifecycle events. They receive a JSON payload on stdin (`event`, tool
name/input/output, prompt, session id…) and `KRONOS_HOOK_EVENT` / `KRONOS_TOOL_NAME` in the
environment. **Exit code 2** (or stdout `{"decision":"block","reason":"…"}`) blocks a
`preToolUse` / `userPromptSubmit`; other stdout (or `{"context":"…"}`) is handed to the model.
The semantics match Claude Code hooks, so many existing hook scripts work unchanged.

```yaml
hooks:
  preToolUse:
    - matcher: "shell"
      command: "jq -e '.input.command | test(\"prod\") | not' > /dev/null || { echo 'no prod commands' >&2; exit 2; }"
  postToolUse:
    - matcher: "write_file"
      command: "npx prettier --write \"$(jq -r .input.path)\" >/dev/null 2>&1 || true"
  stop:
    - command: "osascript -e 'display notification \"Kronos finished\"'"
```

## Memory & skills

| Key | Default | Description |
|---|---|---|
| `memory.enabled` | `true` | Long-term memory (`MEMORY.md`, `USER.md`). |
| `memory.memoryCharLimit` / `memory.userCharLimit` | `4000` / `2500` | Budgets that keep memory curated. |
| `memory.sessionSearch` | `true` | Full-text search over past sessions. |
| `memory.autoExtract` | `false` | After each session, extract durable facts automatically. |
| `skills.enabled` | `true` | Skill index in the prompt + skill tools. |
| `skills.dirs` | `[]` | Extra skill directories. |
| `skills.disabled` | `[]` | Skill names to hide. |
| `skills.autoCreate` | `true` | Nudge the agent to write skills from hard-won procedures. |
| `skills.editBudget` | `3` | Skills the agent may create or change per session. Every change is versioned; `kronos skills rollback` restores. |
| `skills.staleAfterDays` | `60` | Agent-written skills unused this long (or failing more than succeeding) are offered for pruning. |
| `skills.claudeCompat` | `true` | Also load `~/.claude/skills`, `.claude/skills` and Claude agent definitions. |

## Web, browser, media, voice

| Key | Default | Description |
|---|---|---|
| `web.search.provider` | `auto` | `duckduckgo` (no key), `brave`, `tavily`, `exa`, `searxng`, `serper`, `jina`; `auto` uses the first configured key, else DuckDuckGo. |
| `web.fetch.maxChars` | `60000` | Page text kept per fetch. |
| `browser.headless` / `browser.executablePath` / `browser.viewport` | `true` / — / `1280×800` | Playwright browser (`npm i -g playwright` or `KRONOS_CHROMIUM`). |
| `image.provider` / `image.model` / `image.size` | `openai` / `gpt-image-1` / `1024x1024` | Also `fal`, `replicate`, `none` (procedural pixel-art fallback). |
| `voice.stt` / `voice.sttModel` | `openai` / `whisper-1` | Speech-to-text (`groq` supported). |
| `voice.tts` / `voice.ttsModel` / `voice.voice` | `browser` / `gpt-4o-mini-tts` / `alloy` | Text-to-speech (`openai`, `elevenlabs`, `browser`, `none`). |

## Gateway & platforms

| Key | Default | Description |
|---|---|---|
| `gateway.host` / `gateway.port` | `127.0.0.1` / `7777` | Bind address. Non-loopback requires a token. |
| `gateway.token` | `${KRONOS_GATEWAY_TOKEN}` | Shared secret for the UI/API. |
| `gateway.openaiApi` | `true` | Serve `/v1/models` and `/v1/chat/completions`. |
| `gateway.cors` | `[]` | Extra allowed origins. |
| `gateway.publicUrl` | `""` | Public base URL (used in webhook instructions). |
| `platforms.*` | disabled | See [MESSAGING.md](MESSAGING.md). |

## Cron, UI, updates

| Key | Default | Description |
|---|---|---|
| `cron.enabled` | `true` | Run automations while a gateway/desktop app is running. |
| `cron.timezone` | `""` | IANA zone for schedules (empty = system). |
| `cron.maxConcurrent` | `2` | Parallel automation runs. |
| `ui.theme` / `ui.mode` | `kronos` / `system` | Themes: `kronos` (Graphite, default), `titan`, `midnight`, `ember`, `mono`, `cyberpunk`, `slate`, `aurora`, `sakura`; modes `light`, `dark`, `system`. |
| `ui.toolDisplay` | `product` | `product` (friendly summaries) or `technical` (raw inputs/outputs). |
| `ui.fontSize` / `ui.density` / `ui.sendOnEnter` / `ui.showTokenUsage` / `ui.wallpaper` | | Appearance preferences. |
| `updates.channel` / `updates.autoCheck` | `stable` / `true` | Desktop auto-update channel. |
| `telemetry.enabled` | `false` | Kronos sends no telemetry; reserved. |

## MCP servers

```yaml
mcp:
  servers:
    github:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
    docs:
      url: https://mcp.example.com/mcp
      headers: { Authorization: "Bearer ${DOCS_TOKEN}" }
      include: ["search_*", "get_*"]     # expose only matching tools
      timeoutMs: 60000
```

## Profiles

A profile is a complete, isolated Kronos home (config, keys, memory, skills, sessions, cron)
under `~/.kronos/profiles/<name>`. Switch with the person icon in the app,
`kronos profile use <name>`, `-p <name>` per command, or `KRONOS_PROFILE`. A gateway serves
one profile; run a second gateway (`kronos -p family gateway --port 7778`) to give another
profile its own bots.

## Project files

Kronos reads instruction files from the working directory up to the repository root:
`KRONOS.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`,
`.github/copilot-instructions.md`, `.kronos/KRONOS.md` — plus `~/.kronos/KRONOS.md` for global
instructions. Project-specific skills, agents and commands live in `.kronos/skills`,
`.kronos/agents` and `.kronos/commands`.

## GitHub

| Key | Default | Description |
|---|---|---|
| `github.token` | `${GITHUB_TOKEN}` | Personal access token; empty → the GitHub CLI's (`gh auth token`). Set from Settings → GitHub or `kronos github login`. |
| `github.apiUrl` / `github.webUrl` | `https://api.github.com` / `https://github.com` | GitHub Enterprise: your server's API and web URLs. |
| `github.reposDir` | `''` | Where repositories are cloned (default `<profile>/repos`). |
| `github.shellAuth` | `true` | Authenticate `git` in the agent's shell for GitHub checkouts. |
| `github.officialApp` | `{slug: '', clientId: ''}` | The public Kronos GitHub App behind **Connect GitHub** (device flow — only its public client id is needed). |
| `github.bot` | `{enabled: true, trigger: '@kronos', allowed: [OWNER, MEMBER, COLLABORATOR], mode: yolo, model: null, maxMinutes: 30}` | Answering mentions in issues and pull requests (needs the Kronos GitHub App and `gateway.publicUrl`). |

The Kronos GitHub App's credentials live in `<profile>/github-app.json` (mode 600). See
[GITHUB.md](GITHUB.md).

## Environment variables

| Variable | Purpose |
|---|---|
| `KRONOS_HOME` | Home directory (default `~/.kronos`). |
| `KRONOS_PROFILE` | Active profile override. |
| `KRONOS_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, `silent`. |
| `KRONOS_UI_DIR` | Serve the web UI from another directory. |
| `KRONOS_BUNDLED_SKILLS` | Location of the bundled skills. |
| `KRONOS_CHROMIUM` | Chromium executable for the `browser` tool. |
| `KRONOS_DISABLE_SQLITE` | Force the JSON session store. |
| provider keys | see [`.env.example`](../.env.example) |
