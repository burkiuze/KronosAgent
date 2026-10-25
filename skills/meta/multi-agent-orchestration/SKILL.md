---
name: multi-agent-orchestration
description: Split large tasks across parallel subagents (explorer, researcher, coder, reviewer, planner or custom agents) with clear briefs, then merge and verify their results. Use for broad research, large refactors across many files, multi-perspective review, or anything that benefits from parallel independent work.
version: 1.0.0
category: meta
tags: [subagents, delegate, parallel, orchestration]
requires:
  toolsets: [delegate]
---

# Multi-agent orchestration

Subagents start **cold** — they don't see this conversation. Every brief must be
self-contained. Parallelism pays off only for independent work.

## When to delegate

- ✅ Independent sub-questions (research different vendors), sweeping many files for
  information, multiple review lenses (security / performance / tests), generating variants.
- ❌ Tightly coupled edits to the same files, tiny tasks (overhead > benefit), anything that
  needs the user's live input.

## Writing a brief

```
Goal: <one sentence; what done looks like>
Context: <repo path, relevant files, constraints, decisions already made>
Scope: <exactly which files/dirs/questions are yours; what NOT to touch>
Output: <format — e.g. "a list of findings with file:line and evidence", "a patch summary">
Verification: <how to check your own result before returning>
```

Pick the agent type: `explorer` (read-only search), `researcher` (web), `coder` (edits),
`reviewer` (critique), `planner` (plans only), or a custom agent from `.kronos/agents/`.

## Run

Call `delegate` with several tasks in one call to run them concurrently. Give coders
non-overlapping file sets to avoid conflicting edits.

## Merge

Treat subagent output as **claims to verify**, not facts: spot-check file:line references,
rerun the tests yourself, reconcile contradictions (or send a follow-up task to settle them).
Then present one integrated answer — the user shouldn't have to read N reports.
