---
name: dependency-upgrade
description: Upgrade project dependencies or runtimes safely — audit outdated packages, read changelogs for breaking changes, upgrade in batches, fix breakages, verify with tests. Use for "update dependencies", major version bumps, security patches, Node/Python version upgrades.
version: 1.0.0
category: engineering
tags: [dependencies, upgrade, npm, pip, security-patch]
requires:
  toolsets: [shell, files, web]
---

# Dependency upgrades

## 1. Inventory

- npm: `npm outdated`, `npm audit` · pnpm: `pnpm outdated` · yarn: `yarn outdated`
- Python: `pip list --outdated`, `pip-audit`, `uv pip list --outdated`
- Go: `go list -u -m all` · Rust: `cargo outdated` · Ruby: `bundle outdated`
Classify: patch / minor / **major**; security fixes first.

## 2. Plan batches

1. Security patches + patch/minor bumps (low risk) together.
2. Each major bump alone, with its ecosystem companions (e.g. `react` + `react-dom` + `@types/react`).
3. Runtime upgrades (Node/Python) separately, updating CI, Docker images, `.nvmrc`/`engines`.

## 3. For each major bump

- Read the changelog / migration guide (`web_fetch` the GitHub releases page or
  `CHANGELOG.md`). Extract breaking changes into a todo list.
- Search the codebase for each affected API (`grep`).
- Check for official codemods (`npx @next/codemod`, `npx react-codemod`, etc.).

## 4. Upgrade & verify

Install, then run type-check, lint, tests and build. Fix breakages with minimal changes.
Regenerate lockfiles with the package manager — never hand-edit them.

## 5. Report

Table: package, from → to, breaking changes handled, verification. Flag anything deferred
(and why), plus deprecation warnings that will bite next time.
