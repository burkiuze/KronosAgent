---
name: release-notes
description: Generate release notes or a CHANGELOG entry from git history, PRs and issues — grouped, user-facing, with breaking changes and upgrade steps called out. Use when tagging a release, writing "what's new", or updating CHANGELOG.md.
version: 1.0.0
category: writing
tags: [changelog, release, git, semver]
requires:
  toolsets: [shell, files]
---

# Release notes

## Gather

Run `scripts/changes.sh [from-ref] [to-ref]` (defaults: last tag → HEAD). It prints commits
grouped by Conventional Commit type with authors and PR numbers. If the repo doesn't use
conventional commits, classify each commit yourself from its subject and diff.

## Write for users, not committers

- Group: **⚠️ Breaking changes**, **✨ Features**, **🐛 Fixes**, **⚡ Performance**,
  **📚 Docs**, **🔧 Internal** (often omitted for end users).
- Rewrite subjects as benefits: "fix(api): handle nil cursor" → "Paginating past the last page
  no longer returns a 500 error."
- Breaking changes get migration steps with before/after snippets.
- Credit contributors (`@handle`) and link PRs/issues.
- Suggest the semver bump: breaking → major, feature → minor, fixes only → patch.

## CHANGELOG.md

Follow Keep a Changelog: newest first, `## [x.y.z] - YYYY-MM-DD`, sections Added / Changed /
Deprecated / Removed / Fixed / Security, and compare links at the bottom.
