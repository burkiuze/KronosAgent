# Security model

An agent that can run commands, edit files and talk to the internet on your behalf needs a
clear safety story. Kronos's defaults are conservative; every relaxation is explicit.

## Threats we design for

1. **The model makes a mistake** — deletes the wrong directory, force-pushes, runs a destructive
   migration.
2. **Prompt injection** — a web page, file, email, issue or tool result contains instructions
   that try to make the agent exfiltrate data or run commands.
3. **Strangers reaching the agent** — through an exposed gateway or a public chat bot.
4. **Malicious extensions** — a skill or MCP server that does more than it claims.
5. **Secret leakage** — API keys ending up in transcripts, logs, chat messages or commits.

## Controls

### Permission modes and rules
- **Ask** (default): reads and web lookups are automatic; writes, command execution, outbound
  actions (messages, non-GET HTTP requests, scheduling, skill installs) and MCP tools that are not
  marked read-only ask first. **Auto-edit** additionally auto-approves file edits inside the
  workspace. **Plan** forbids writes until you approve the plan (`exit_plan_mode`). **YOLO**
  approves everything *except* the always-ask cases below.
- Rules: `safety.deny` (always wins) and `safety.allow`, e.g. `shell(git status)`,
  `shell(npm test*)`, `write_file(src/**)`, `mcp__github__get_*`. Approving "always" in the UI
  adds a precise allow rule rather than switching modes.

### Always ask
- **Dangerous commands** are detected by pattern regardless of mode (`rm -rf` on broad paths,
  `mkfs`, `dd` to devices, fork bombs, `curl … | sh`, `git push --force`, `chmod -R 777 /`,
  `DROP DATABASE`, shutdown/reboot, …). Set `safety.dangerousCommands: block` to refuse them
  outright.
- **Protected paths** (`~/.ssh/**`, `~/.aws/credentials`, `~/.kronos/.env`, `/etc/shadow`, plus
  your own) always ask before access.
- `safety.workspaceOnly: true` refuses writes outside the workspace.

### Isolation
- `terminal.backend: docker` runs every command in a container with only the workspace mounted
  (optionally without network: `terminal.docker.network: false`). `ssh` runs them on another
  machine. Subagents inherit the parent's backend and permission policy.
- **Checkpoints** snapshot files before edits; `undo` restores them.
- **Hooks** let you enforce your own policy (exit code 2 blocks a tool call).

### Prompt-injection hygiene
- Tool results are presented to the model as data; the system prompt tells the agent that
  instructions found in fetched content, files or messages are not from the user.
- The risky actions an injection would need (shell, writes, sending messages, MCP writes) go
  through the permission policy above — in Ask mode a human sees them first.
- `send_message`, non-GET `http_request`, `cron_create` and skill installs are `external`-risk:
  in Ask, Auto-edit and Plan modes they ask unless explicitly allowed.

### Gateway exposure
- Binds to `127.0.0.1` by default. Binding to any other address **requires** a token; one is
  generated and printed if you don't set `KRONOS_GATEWAY_TOKEN`.
- The token is accepted as `Authorization: Bearer`, `?token=` or cookie and compared in constant
  time; opening the UI with `?token=` sets an HttpOnly, SameSite=Strict cookie. CORS is an
  explicit allow-list.
- The desktop app uses a random per-launch token on loopback and loads the UI only from its own
  origin; external links open in the system browser; the renderer is sandboxed with context
  isolation and only a small IPC bridge.
- To use Kronos remotely, prefer a private network (Tailscale/WireGuard) or an authenticated
  reverse proxy over exposing the port.

### Messaging
- Unknown chat users get a **pairing code** and nothing else until you approve them.
- Runs from chat platforms use `platforms.<id>.mode` (default `auto-edit`): shell commands and
  other risky actions are approved in the chat (`/approve`, `/deny`).
- Webhooks verify their secret in constant time; WhatsApp deliveries verify Meta's
  `X-Hub-Signature-256` HMAC when the app secret is configured (strongly recommended).

### Skills and MCP servers
- Skills are plain files you can read before enabling; installing from git shows what was
  added. Scripts inside skills run through the normal shell permission flow.
- MCP servers run with the environment you give them; restrict exposed tools with
  `include`/`exclude`, and keep destructive tools on ask.

### Secrets
- Keys live in `~/.kronos/.env` (mode 600 where supported), referenced from config as
  `${NAME}`; the UI and `kronos config get` mask them.
- `safety.redactSecrets` masks key-shaped strings (provider keys, GitHub/Slack tokens, private
  keys, bearer tokens) in tool output before it reaches the model, transcripts or chats.
- Kronos sends **no telemetry**.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories on
`burkiuze/KronosAgent` rather than in public issues. Include steps to reproduce and the
affected version (`kronos version`).
