# Agent landscape analysis — and what Kronos takes from each

This document records the survey that shaped Kronos: what the most widely used agents do best,
where users hit their limits, and which ideas Kronos adopts. It is written from public
documentation, repositories and product announcements available up to October 2026. Agents
move fast — if something here is out of date, please open an issue or PR.

> **Reading the comparison honestly.** Kronos is a v1 that *combines* many proven ideas in one
> runtime. It does not out-benchmark specialised tools at their own speciality (e.g. an IDE's
> inline completions, or a cloud agent's managed fleet of VMs). Where a competitor still leads,
> this document says so, and the [roadmap](#gaps-and-roadmap) tracks it.

## The agents we studied

### Hermes Agent (Nous Research)
Open-source (MIT), Python, model-agnostic personal agent that "grows with you".
**Best at:** a closed learning loop — curated persistent memory (`MEMORY.md` / `USER.md`),
agent-written **skills** that it patches as it learns, FTS5 search across past sessions, and a
single gateway process that serves Telegram, Discord, Slack, WhatsApp, Signal, email and more.
Cron scheduling with delivery to any platform, isolated subagents, many terminal backends
(local, Docker, SSH and serverless sandboxes), MCP, and a migration path from OpenClaw. The
community desktop shell (the video that inspired this project) adds a native window with
New agent / Skills / Messaging / Artifacts / Automations, profiles and a status bar.
**Limits users report:** Python environment setup; the desktop experience is separate from the
core project; fewer coding-workflow conveniences (diff review, checkpoints, IDE-grade file
tools) than dedicated coding agents.
**Kronos adopts:** the memory files with character budgets and a frozen per-session snapshot,
skill nudges and `skill_manage` (create/patch/update), session search, the gateway-with-pairing
model, natural-language cron with delivery targets, profiles, the desktop information
architecture — and an importer (`kronos import hermes`).

### OpenClaw (formerly Clawdbot / Moltbot)
Open-source, TypeScript, local-first personal assistant that went viral in early 2026.
**Best at:** being reachable everywhere (WhatsApp, Telegram, iMessage, Slack, Discord, Signal…)
from an always-on gateway on your own machine; workspace files that define the assistant
(`AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`); proactive heartbeats; a
skills registry; browser control; companion apps and voice.
**Limits users report:** security incidents from internet-exposed gateways and from malicious
third-party skills; broad default permissions; complexity of the configuration surface.
**Kronos adopts:** `SOUL.md` personas, heartbeat-style automations (cron + delivery), the
"one gateway, many chat apps" shape — **with safer defaults**: loopback-only binding, mandatory
token for non-loopback, pairing codes for unknown chat users, per-platform permission modes,
dangerous-command detection and protected paths. Importer: `kronos import openclaw`.

### Claude Code (Anthropic)
Agentic coding tool in the terminal, IDEs, desktop, web and mobile, with an SDK.
**Best at:** a mature agent loop for software work — precise file tools (read/edit/multi-edit),
permission modes and allow/deny rules, plan mode, hooks, subagents with their own context,
skills, slash commands, `CLAUDE.md` project memory, checkpoints/rewind, MCP, headless mode.
**Limits:** tied to Anthropic models; not a multi-platform chat assistant; persistent
cross-project personal memory and scheduled automations are not its focus.
**Kronos adopts:** the permission model (ask / auto-edit / plan / bypass) and rule syntax
`tool(pattern)`, hooks with exit-code-2 blocking, subagent definitions as markdown files
(Kronos also loads `~/.claude/agents` and `.claude/agents`), `SKILL.md` compatibility
(including `~/.claude/skills`), `CLAUDE.md` / `AGENTS.md` loading, checkpoints with undo/retry,
custom slash commands with `$ARGUMENTS`, and `@file` mentions.

### OpenAI Codex CLI
Open-source terminal coding agent (Rust) plus cloud tasks and IDE extension.
**Best at:** OS-level sandboxing of commands (Seatbelt on macOS, Landlock/seccomp on Linux),
clear approval modes, `AGENTS.md`, fast local execution.
**Limits:** coding-only scope; OpenAI-first.
**Kronos adopts:** `AGENTS.md`, approval-mode ergonomics, and sandboxing via **Docker/SSH
backends**. *Codex still leads* on kernel-level sandboxing of the local backend (on our roadmap).

### Gemini CLI (Google)
Open-source terminal agent with very large context windows, Google Search grounding, MCP,
`GEMINI.md` context files and a generous free tier.
**Kronos adopts:** `GEMINI.md` loading, first-class Gemini provider, search-grounded research
via the web toolset and pluggable search providers.

### OpenHands (All Hands AI)
Open-source platform for autonomous software agents with a sandboxed runtime, web UI, and
strong results on SWE-bench-style evaluations; cloud and self-hosted.
**Best at:** long-horizon autonomous coding in an isolated runtime.
**Kronos adopts:** containerised execution (Docker backend with the workspace mounted), a
browser-based UI for long runs. *OpenHands still leads* on published autonomous-SWE benchmarks
and managed cloud runtimes.

### Cline, Roo Code, Kilo Code (VS Code agents) and Cursor (AI IDE)
**Best at:** living inside the editor — plan/act modes, diff previews, checkpoints, MCP
marketplaces (Cline), background agents and inline completions (Cursor).
**Kronos adopts:** plan mode with an explicit `exit_plan_mode` approval, visual diffs on every
edit, a files panel with editor in the desktop app, `.cursorrules`/`.windsurfrules` loading, and
`kronos import cursor`. *IDEs still lead* on inline completion and editor-native UX.

### Aider
Terminal pair-programmer with a repository map, architect/editor model split and automatic git
commits. **Kronos adopts:** separate cheaper models for subagents/summaries (`model.subagent`,
`model.summary`) and git-aware workflows via the `git-workflow` skill and `/review`.

### Goose (Block)
Open-source on-machine agent (desktop + CLI) built around MCP extensions and shareable recipes.
**Kronos adopts:** MCP as the extension mechanism (client **and** server), desktop + CLI parity,
skills as shareable recipes installable from git.

### Devin, Manus, ChatGPT agent mode, Claude Cowork (cloud/managed agents)
**Best at:** fully managed environments — a remote VM or browser the agent drives, long
unattended tasks, team integrations (Slack, ticketing), polished progress reporting.
**Limits:** closed, cloud-only, per-seat pricing, your data lives in their environment.
**Kronos adopts:** unattended runs (cron), progress you can follow from chat apps, artifacts
(reports, files, images) collected in one place, wide parallel research via subagents — while
running on **your** machine with **your** keys.

### Letta (MemGPT), AutoGPT, Open Interpreter, CrewAI / AutoGen / LangGraph, browser-use
Frameworks and pioneers: hierarchical/self-editing memory (Letta), autonomous goal loops
(AutoGPT), local code interpretation (Open Interpreter), multi-agent orchestration patterns
(CrewAI, AutoGen, LangGraph) and LLM-driven browser automation (browser-use).
**Kronos adopts:** agent-curated memory with explicit budgets rather than unbounded recall;
`execute_code` for Python/JS/Bash; parallel subagents with typed roles and depth limits; a
Playwright-backed `browser` tool.

## Feature matrix

Legend: ✅ built in · ◐ partial / via plugin or companion · — not a focus · ? not verified.
Based on public docs as of Oct 2026; corrections welcome.

| Capability | Kronos | Hermes | OpenClaw | Claude Code | Codex CLI | Gemini CLI | OpenHands | Cline | Aider | Goose |
|---|---|---|---|---|---|---|---|---|---|---|
| Open source | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Terminal UI | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ◐ | — | ✅ | ✅ |
| Desktop app | ✅ | ◐ | ◐ | ✅ | — | — | — | — | — | ✅ |
| Web UI | ✅ | ◐ | ✅ | ✅ | — | — | ✅ | — | ◐ | ◐ |
| Chat apps (Telegram, Discord, Slack, WhatsApp…) | ✅ | ✅ | ✅ | ◐ | — | — | ◐ | — | — | — |
| Any model / local models | ✅ | ✅ | ✅ | — | ◐ | — | ✅ | ✅ | ✅ | ✅ |
| Persistent personal memory | ✅ | ✅ | ✅ | ◐ | ◐ | ◐ | — | ◐ | — | ◐ |
| Agent-written skills | ✅ | ✅ | ◐ | ◐ | — | — | — | — | — | ◐ |
| Search across past sessions | ✅ | ✅ | ◐ | ◐ | — | — | ◐ | ◐ | — | ◐ |
| Scheduled automations with delivery | ✅ | ✅ | ✅ | ◐ | — | — | — | — | — | ◐ |
| Parallel subagents | ✅ | ✅ | ◐ | ✅ | ◐ | ◐ | ◐ | ◐ | — | ◐ |
| MCP client | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| Acts as MCP server | ✅ | ◐ | — | ✅ | ✅ | — | — | — | — | — |
| OpenAI-compatible API | ✅ | ◐ | ◐ | — | — | — | ◐ | — | — | — |
| Permission modes + allow/deny rules | ✅ | ◐ | ◐ | ✅ | ✅ | ✅ | ◐ | ✅ | ◐ | ◐ |
| Hooks | ✅ | ? | ◐ | ✅ | ◐ | ? | — | ? | — | — |
| Plan mode | ✅ | ? | — | ✅ | ◐ | ◐ | — | ✅ | ✅ | ◐ |
| File checkpoints / undo | ✅ | ◐ | — | ✅ | ◐ | ✅ | ◐ | ✅ | ✅ | — |
| Docker / SSH execution | ✅ | ✅ | ◐ | — | ◐ | ◐ | ✅ | — | — | — |
| Browser automation | ✅ | ✅ | ✅ | ◐ | — | ◐ | ✅ | ✅ | — | ◐ |
| Voice in/out, image generation | ✅ | ✅ | ✅ | — | — | — | — | — | ◐ | ◐ |
| Profiles (isolated personas) | ✅ | ✅ | ◐ | — | ◐ | — | — | — | — | — |
| Import from other agents | ✅ | ✅ | — | — | — | — | — | — | — | — |
| Works fully offline (local model) | ✅ | ◐ | ◐ | — | — | — | ◐ | ◐ | ◐ | ◐ |

## Design principles we derived

1. **One runtime, every surface.** The CLI, desktop app, web UI, chat platforms, cron and the
   OpenAI/MCP APIs all drive the *same* `Kronos` runtime: same memory, skills, sessions and
   permission rules. A conversation started anywhere can be continued anywhere.
2. **Learning is explicit and bounded.** Memory has character budgets and is curated by the
   agent (add/replace/remove), skills are versioned files you can read and edit, and the system
   prompt is frozen per session so prompt caching stays effective.
3. **Safe defaults, fast escape hatches.** Ask before acting by default; allow rules and modes
   let power users go fast; some things (catastrophic commands, protected paths) always ask.
4. **Open formats.** `SKILL.md`, `AGENTS.md`/`CLAUDE.md`, MCP, OpenAI-compatible HTTP, YAML
   config, Markdown memory, JSONL artifacts, SQLite sessions — nothing proprietary to escape.
5. **Any model.** Provider-specific power (Anthropic prompt caching, adaptive thinking, effort,
   server-side fallbacks) where available, a portable OpenAI-compatible path everywhere else,
   and a fallback chain across providers.
6. **Honest first run.** A fresh install opens onto a "connect a provider" prompt with a
   button straight to the provider settings; nothing answers with a stand-in model. The offline
   demo model exists for tests and only runs when chosen explicitly.

## Gaps and roadmap

Honest list of places where others are ahead today, and what we plan:

- **Kernel-level sandbox for the local backend** (Seatbelt/Landlock like Codex) — today use the
  Docker or SSH backend for isolation.
- **Serverless sandboxes** (Modal, Daytona, E2B) as terminal backends, as Hermes offers.
- **Mobile companion apps / voice wake word** (OpenClaw) — today use any chat app plus voice
  memos, or the web UI on your phone.
- **IDE extensions** (VS Code / JetBrains) — today use the desktop app's files panel, the CLI in
  the IDE terminal, or Kronos as an MCP server inside your editor's agent.
- **Published benchmark results** (SWE-bench, Terminal-Bench, GAIA) — a reproducible harness
  is planned; we will publish numbers only from runs anyone can repeat.
- **iMessage** and **email inbound** channels.
- **Skill marketplace** with signing and review, learning from the malicious-skill incidents in
  other ecosystems.
