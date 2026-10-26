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
**Kronos adopts:** `AGENTS.md`, approval-mode ergonomics, its review rubric (discrete,
actionable, introduced-by-this-change findings with a priority and an overall verdict) and its
**kernel-level sandbox**: `terminal.sandbox` confines local commands with Landlock (Linux, through
the dependency-free Rust helper `native/sandbox`, ~300 KB) or Seatbelt (macOS) — writes only to
the project and temp, optionally no network — without Docker's daemon and memory. See
[the Codex comparison](#codex-open-code-review-and-hermes-in-depth).

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
| Code review with inline PR comments | ✅ | ◐ | — | ✅ | ✅ | ◐ | ◐ | ◐ | — | — |
| Kernel sandbox for local commands | ✅ | — | — | ✅ | ✅ | ✅ | — | — | — | — |
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

- **Windows sandbox** for the local backend (Codex has one) — today use the Docker backend there.
- **Approval escalation from inside the sandbox** (re-run a denied command unsandboxed after one
  click, as Codex does) — today the denial is reported and the user changes the mode.
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

## Codex, open-code-review and Hermes in depth

We read the source of three agents closely — OpenAI's Codex (Rust), Alibaba's open-code-review
(Go) and Nous Research's Hermes Agent (Python) — and took what makes each one good.

### Code review: open-code-review and Codex `/review` vs `kronos review`

| | open-code-review | Codex `/review` | Kronos |
|---|---|---|---|
| What it reviews | diff vs a branch, commits | uncommitted, branch, commit | uncommitted (incl. new files), staged, branch (merge base), commit, patch file, **GitHub pull request** (throwaway worktree at the PR head) |
| File selection | extension allow-list, excluded paths, token ceiling | — | lock/generated/vendored/binary/data files and **secret paths never reach the model**; oversized files listed with the reason |
| Splitting work | LLM-chosen groups of ≤ 10 files | one agent | deterministic groups (tests travel with their code, same area together) — reproducible and free |
| Reviewer | one agent per group, `code_comment` + `task_done` | one agent, JSON output | one **read-only agent per group in parallel** with `review_comment`/`review_done`, coverage enforced (every file must be reviewed), a risk plan for large groups, and a JSON fallback for models without tool calling |
| Rules | 56 per-language documents, many of them style rules | AGENTS.md attribution | per-language **defect** checklists (bugs, security, concurrency, leaks — no style policing) + REVIEW.md, the review sections of AGENTS.md/CLAUDE.md and path-scoped `.kronos/review/*.md`, cited in findings |
| Placing comments | `existing_code` matched in the hunk, then file, then other files, then an LLM | model's line numbers | quoted code matched ignoring indentation (diff first, nearest to the reported line), cross-file relocation on a unique hit, partial-path resolution, snapping onto the hunk |
| False positives | "fact-checker" prompt removing only on grounds A/B, protected subjects | confidence score | a separate refutation pass with grounds A–D (code absent, a quoted line disproves it, untouched code, pure taste), **protected subjects** (security, concurrency, compatibility, reliability) only removable on A/B, severity can only go down; every dropped finding is kept with its reason (`--show-dropped`) |
| Output | terminal, JSON, CI comments | TUI | text, Markdown, JSON, **SARIF 2.1.0**, GitHub review with one-click ```` ```suggestion ```` blocks; `--fail-on high` for CI |
| GitHub | CI integrations | — | `@kronos review` on any pull request, or `github.bot.autoReview` for every new one |

### Sandbox: Codex vs Kronos

Codex sandboxes every command by default: Seatbelt on macOS, bubblewrap + seccomp (or legacy
Landlock) on Linux, a restricted token on Windows, plus approval escalation. Kronos now has the
same model for the local backend, opt-in so nothing breaks for existing users:

- **Linux:** `native/sandbox` is a std-only Rust binary (no crates, builds offline in ~10 s,
  ~300 KB). It applies a Landlock ruleset — the whole file system readable, writes only beneath
  the project root (git top level), temp directories and `terminal.sandbox.writable` — sets
  `no_new_privs` and `exec`s the shell. With `network: false` it denies TCP through Landlock
  (kernel 6.7+) or moves the command into an empty user + network namespace. No root, no daemon,
  nothing left behind. Without the helper, bubblewrap is used if installed.
- **macOS:** `sandbox-exec` with a generated Seatbelt profile (`allow default`, `deny file-write*`
  except the writable roots and terminal devices, `deny network-*` for IP when offline).
- Background processes are sandboxed the same way; `kronos doctor` reports the engine; the agent's
  system prompt says the commands are sandboxed so it does not fight the denials.

Resource cost: one `exec` of a 300 KB static helper per command — microseconds and no resident
memory — against Docker's daemon and a container per workspace.

### Hermes Agent details we took

- **Stale-write guard** (Hermes `file_state`): `write_file` will not replace a file this agent
  never read, or one that changed on disk since it read it (the user, a formatter, another agent);
  the warning is given once per file version so a deliberate overwrite still works.
- **Throwaway worktrees** (Hermes `subagent_worktree`): pull request reviews run in a detached
  `git worktree` at the PR head that is removed afterwards — the user's checkout is never touched.
- Already present before this round: post-edit diagnostics (Hermes LSP lint delta → Kronos syntax
  check after every edit), session search, skills with provenance, progressive disclosure of large
  tool sets in lean mode.

### Second pass: what else we took, module by module

| From | Module | In Kronos |
|---|---|---|
| Codex | `execpolicy`, `shell-command` (tree-sitter bash) | `safety/shellparse`: commands are parsed (quotes, `&&`/`;`/`|`, wrappers like `env`, `sudo`, `xargs`, `sh -c`); read-only detection checks arguments; allow rules must cover every command in a line; "always allow" never suggests a broad prefix. Fixed two holes this found: `env <cmd>` counted as read-only, and `git status*` approving `git status && rm -rf src` |
| Codex | on-request approvals | with the OS sandbox on, Auto-edit runs non-dangerous commands without asking |
| Codex | guardian | `safety/guardian`: a second model rates risk and user authorization of actions nobody is there to approve (bot, automations); critical always refused |
| Codex | compaction | earlier user messages are carried verbatim next to the summary |
| Codex | unified exec | a command past its timeout moves to the background instead of being killed |
| Codex | tool_search | large MCP tool sets are searched and loaded on demand |
| Codex | memories (two phases) | `memory.recaps`: task-history recaps of idle conversations and an index of past work in new conversations |
| Codex | hooks | `permissionRequest` and `preCompact` hooks |
| Codex | multi-agent v2 | the `agents` tool: background subagents (spawn / wait / send / stop) |
| Codex | `exec --output-schema`, `--json` | `kronos run --output-schema`, `--events`, `--output-last-message`, `-c`, `--ephemeral`; `response_format` in the OpenAI-compatible API |
| Codex | network proxy | `terminal.sandbox.allowDomains`: sandboxed commands reach only listed hosts through a filtering proxy, enforced with Landlock port rules |
| Codex | AGENTS.override.md | read in place of AGENTS.md |
| Hermes | fuzzy_match, escape_drift_autocorrect | `util/editmatch`: forgiving edit matching (indentation, whitespace, Unicode, escapes, anchors) with re-indentation |
| Hermes | background_review | `agent.nudges.learning: background`: a separate agent updates memory and skills after a turn |
| Hermes | approval_smart | guardian strips shell comments (injection vector) and takes operator policy |
| Hermes | agent/lsp | `agent.lsp`: errors an edit introduced, from installed language servers |
| Hermes | code_kernel | `execute_code persistent: true`: notebook-like Python/JavaScript kernels |
| Hermes | osv_check | malware check (OSV MAL-*) before installing packages or starting MCP servers |
| Hermes | credential_pool | comma-separated API keys rotate on rate limits and rejections |
| Hermes | url_safety, browser_url_policy | web tools and the browser never reach cloud metadata, also through redirects |
| Hermes | context_references | `@diff`, `@staged`, `@git:<rev>`, `@url:<address>` in prompts |
| open-code-review | `ocr scan`, `--preview` | `kronos review --scan`, `--preview` |

### Third pass: quality of the work, not just the toolbox

Hermes and Codex mostly differ from weaker agents in *how* the model works, not in tool count.
This pass targets the failure modes that make an agent's result untrustworthy:

| Problem | In Kronos |
|---|---|
| "Done" without proof | `agent/evidence`: test, lint, typecheck and build runs are recognized from the parsed command line; a check whose exit code is masked (`| tail` without pipefail, `|| true`, `; echo`) does not count and the model is told so; edits to docs do not ask for verification |
| Prompt injection from repo files, web pages, MCP output | `safety/threats` (after Hermes' threat patterns): context files with injections are not loaded, memory writes with exfiltration phrasing are refused, untrusted tool output gets a warning note |
| Sloppy finishing | system prompt: finish the job, never invent results, "done" means every requirement checked, read back external writes, keep identifiers literal; repository etiquette (dirty worktree, no destructive git, no stray files); outcome-first reports. Models that tend to stop early get an extra execution-discipline block |
| One model's blind spots | `/moa` and `model.advisors`: other models advise before key steps and after failures; the acting model decides |
| Reporting success with work left | before the final answer the harness checks the run itself: plan items written in this run that are still open, and a check (verify, tests, lint, typecheck, build) that failed and has not passed since in a run that changed code. One reminder per run; the model fixes it or says plainly what is unfinished |
| Bugs the author does not see | `agent.selfReview`: when a run changed 15+ lines in a git repository, the review engine (independent reviewers plus the fact-checker) checks the uncommitted changes before the final answer, and confirmed problems go back to the agent once. Default: at the Codemaster effort level |

### Resource use

Kronos keeps the "normal agent" footprint: a Node.js process (the gateway idles at a few tens of
MB, see [PERFORMANCE.md](PERFORMANCE.md)); no GPU is used unless you run a local model yourself;
review groups run with bounded concurrency (`review.concurrency`, default 3); shell progress and
background process output are kept in fixed-size buffers; the sandbox adds no resident process.
