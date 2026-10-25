---
name: git-workflow
description: Day-to-day git — branching, staging hunks, writing commit messages, rebasing vs merging, resolving conflicts, recovering lost work, preparing PRs. Use for any git/GitHub task or when the user is stuck in a git state.
version: 1.1.0
category: engineering
tags: [git, github, commits, pr, merge, rebase]
requires:
  toolsets: [shell]
---

# Git workflow

## Look before acting

`git status`, `git branch -vv`, `git log --oneline --graph -15`, `git stash list`.
Never run destructive commands (`reset --hard`, `push --force`, `clean -fd`, `branch -D`)
without telling the user exactly what will be lost and getting confirmation.

## Commits

- Small and focused; each commit builds and passes tests.
- Conventional Commits style when the repo uses it (`git log` to check):
  `feat(api): add pagination to /users` · `fix: …` · `docs: …` · `refactor: …` · `test: …`.
- Subject ≤ 72 chars, imperative mood; body explains *why*, wraps at 72.
- Stage precisely: `git add -p` equivalent → use `git add <paths>`; review with
  `git diff --cached` before committing.

## Branching

- Feature branches from an up-to-date base: `git fetch origin && git switch -c feat/x origin/main`.
- Keep up to date: on *your own* unshared branch, `git rebase origin/main`; on shared
  branches, `git merge origin/main` (never rewrite others' history).

## Conflicts

1. `git status` lists conflicted files. Open each; understand **both** sides' intent
   (`git log --merge -p <file>`).
2. Resolve, remove markers, run tests. Lockfiles/generated files: regenerate with the tool
   (`npm install`, `poetry lock`), don't hand-merge.
3. `git add` + `git rebase --continue` / `git commit`.

## Recovery

- Lost commit after reset/rebase: `git reflog` → `git branch rescue <sha>`.
- Undo last commit, keep changes: `git reset --soft HEAD~1`.
- Discard a file's changes: `git restore <file>` (confirm first).
- Wrong branch: `git stash` → `git switch right` → `git stash pop`.

## Pull requests

Title like a commit subject. Body: what & why, how to test, screenshots for UI, risk/rollback.
Check for `.github/pull_request_template.md` and follow it. Keep PRs reviewable (< ~400 lines
where possible).
