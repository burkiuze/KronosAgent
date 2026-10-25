---
name: technical-writing
description: Write or improve READMEs, docs, tutorials, design docs, ADRs and API references that are accurate, scannable and runnable. Use for documentation tasks, "write docs for", "improve the README", RFC/design-doc drafting.
version: 1.1.0
category: writing
tags: [docs, readme, documentation, adr, tutorial]
requires:
  toolsets: [files]
---

# Technical writing

## Know the reader and the doc type (Diátaxis)

- **Tutorial** — learning by doing; one happy path; every step runnable.
- **How-to guide** — solve a specific task; assumes basics.
- **Reference** — complete, dry, structured (flags, endpoints, config keys).
- **Explanation** — the why: concepts, architecture, trade-offs.
Don't mix types in one page.

## Ground truth

Read the code/CLI before documenting it. Run every command you write and paste real output.
Check flag names against `--help`. Wrong docs are worse than none.

## README skeleton

1. Name + one-sentence value proposition (+ screenshot/GIF for UIs)
2. Quick start (≤ 5 commands from zero to working)
3. Features (short bullets)
4. Installation options / requirements
5. Usage examples (most common first)
6. Configuration (table: key, default, description)
7. Architecture / how it works (optional link)
8. Contributing, license

## Style

Short sentences, active voice, second person ("you"). Headings as tasks. Code blocks with
language tags; one command per line; no `$` prompts in copy-paste blocks. Tables for options.
Define terms once. Prefer examples over abstractions. Link instead of duplicating.

## Design docs / ADRs

Context → problem → options considered (with trade-offs) → decision → consequences →
open questions. Keep ADRs to one page and immutable (supersede, don't edit).
