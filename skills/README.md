# Bundled skills

Skills are Kronos's procedural memory — folders with a `SKILL.md` (YAML frontmatter + instructions) and optional `scripts/`, `references/` and `templates/`. They follow the open SKILL.md format used by Anthropic Agent Skills, Claude Code and Hermes, so skills can be shared across agents.

Kronos shows the model only each skill's name and description; the full body loads on demand (`skill_view`), so hundreds of skills cost almost no context. Users and the agent itself can add skills under `~/.kronos/skills` (or `.kronos/skills` in a project); see [`meta/skill-authoring`](meta/skill-authoring/SKILL.md).

| Category | Skill | Use it for |
|---|---|---|
| creative | [`image-prompting`](creative/image-prompting/SKILL.md) | Write strong prompts for image generation (OpenAI, Flux/fal, Replicate, SDXL) and iterate |
| data | [`data-visualization`](data/data-visualization/SKILL.md) | Choose the right chart and produce clean, accessible visualisations (matplotlib/plotly PNG or interactive HTML) from data |
| data | [`spreadsheet-analysis`](data/spreadsheet-analysis/SKILL.md) | Load, clean, analyse and summarise CSV/TSV/Excel/Parquet data with Python (pandas) |
| data | [`sql-analysis`](data/sql-analysis/SKILL.md) | Write, explain and optimise SQL for analysis across Postgres, MySQL, SQLite, BigQuery, Snowflake and DuckDB |
| devops | [`ci-setup`](devops/ci-setup/SKILL.md) | Create or fix CI pipelines (GitHub Actions primarily; GitLab CI, CircleCI) |
| devops | [`docker-deploy`](devops/docker-deploy/SKILL.md) | Containerise and deploy applications |
| devops | [`log-analysis`](devops/log-analysis/SKILL.md) | Analyse application, web-server, system or CI logs to find errors, patterns, spikes and root causes |
| devops | [`server-health`](devops/server-health/SKILL.md) | Check the health of a Linux/macOS machine or server |
| documents | [`pdf-tools`](documents/pdf-tools/SKILL.md) | Work with PDF files |
| documents | [`slide-deck`](documents/slide-deck/SKILL.md) | Build presentation slide decks as self-contained HTML (reveal.js) or Markdown (Marp) |
| engineering | [`api-design`](engineering/api-design/SKILL.md) | Design or review HTTP/REST, GraphQL or RPC APIs |
| engineering | [`code-review`](engineering/code-review/SKILL.md) | Review a diff, branch, PR or set of files for correctness bugs first, then security, performance and maintainability |
| engineering | [`codebase-onboarding`](engineering/codebase-onboarding/SKILL.md) | Rapidly understand an unfamiliar repository |
| engineering | [`debugging`](engineering/debugging/SKILL.md) | Systematically find the root cause of a bug, crash, failing test, flaky behaviour or wrong output |
| engineering | [`dependency-upgrade`](engineering/dependency-upgrade/SKILL.md) | Upgrade project dependencies or runtimes safely |
| engineering | [`frontend-ui`](engineering/frontend-ui/SKILL.md) | Build or polish web front-ends (React/Vue/Svelte/plain HTML+CSS, Tailwind) |
| engineering | [`git-workflow`](engineering/git-workflow/SKILL.md) | Day-to-day git |
| engineering | [`performance-profiling`](engineering/performance-profiling/SKILL.md) | Measure and fix slow code, high memory, slow builds, slow queries or slow pages using profilers and benchmarks before optimising |
| engineering | [`refactoring`](engineering/refactoring/SKILL.md) | Restructure code without changing behaviour |
| engineering | [`security-audit`](engineering/security-audit/SKILL.md) | Audit an application or change for security vulnerabilities |
| engineering | [`test-driven-development`](engineering/test-driven-development/SKILL.md) | Implement features or fixes test-first (red → green → refactor), choosing the project's existing test framework |
| meta | [`kronos-setup`](meta/kronos-setup/SKILL.md) | Help the user configure Kronos itself |
| meta | [`mcp-integration`](meta/mcp-integration/SKILL.md) | Connect Kronos to external tools via Model Context Protocol servers (stdio or HTTP) |
| meta | [`multi-agent-orchestration`](meta/multi-agent-orchestration/SKILL.md) | Split large tasks across parallel subagents (explorer, researcher, coder, reviewer, planner or custom agents) with clear briefs, then merge and verify their results |
| meta | [`skill-authoring`](meta/skill-authoring/SKILL.md) | Create, improve and test Kronos skills (SKILL.md + scripts/references) |
| productivity | [`daily-briefing`](productivity/daily-briefing/SKILL.md) | Compile a concise morning briefing |
| productivity | [`inbox-triage`](productivity/inbox-triage/SKILL.md) | Triage an email inbox or message backlog |
| productivity | [`meeting-notes`](productivity/meeting-notes/SKILL.md) | Turn meeting transcripts, recordings or rough notes into clean minutes |
| productivity | [`reminders`](productivity/reminders/SKILL.md) | Create, list, change and cancel reminders and recurring nudges in natural language ("remind me tomorrow at 9 to call mom", "every Friday 5pm ask me for my weekly review") delivered to the user's chat platform or desktop |
| research | [`competitive-analysis`](research/competitive-analysis/SKILL.md) | Map competitors for a product or company |
| research | [`deep-research`](research/deep-research/SKILL.md) | Research a question across many sources and synthesise a cited, balanced report |
| research | [`fact-check`](research/fact-check/SKILL.md) | Verify specific claims, statistics, quotes or news against reliable sources and give a verdict with evidence |
| research | [`paper-reading`](research/paper-reading/SKILL.md) | Read and explain academic papers (arXiv, PDFs, DOIs) |
| research | [`web-scraping`](research/web-scraping/SKILL.md) | Extract structured data from websites |
| writing | [`email-drafting`](writing/email-drafting/SKILL.md) | Draft clear, well-toned emails and messages |
| writing | [`release-notes`](writing/release-notes/SKILL.md) | Generate release notes or a CHANGELOG entry from git history, PRs and issues |
| writing | [`technical-writing`](writing/technical-writing/SKILL.md) | Write or improve READMEs, docs, tutorials, design docs, ADRs and API references that are accurate, scannable and runnable |
| writing | [`translation`](writing/translation/SKILL.md) | Translate or localise text, documents, UI strings (JSON/YAML/PO) and markdown between languages while preserving formatting, placeholders, tone and terminology |
