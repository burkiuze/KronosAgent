---
name: code-review
description: Review a diff, branch, PR or set of files for correctness bugs first, then security, performance and maintainability. Use when asked to review code, check a PR, audit a change before merging, or "look over" something you or another agent wrote.
version: 1.2.0
category: engineering
tags: [review, pr, quality, bugs]
requires:
  toolsets: [files, shell]
---

# Code review

A review is only useful if every finding is **real** and **actionable**. Optimise for
precision: one verified bug beats ten speculative style notes.

## 1. Establish the scope

- Diff of the working tree: `git diff` (unstaged) and `git diff --cached` (staged).
- A branch against its base: `git merge-base HEAD origin/main` → `git diff <base>...HEAD`.
- A PR number with the `gh` CLI if available: `gh pr diff <n>` and `gh pr view <n>`.
- Read the description / linked issue: you review against *intent*, not just syntax.

Record the list of changed files with `git diff --stat` and add a todo per file with `todo_write`
when there are more than three.

## 2. Read in context, not just the hunk

For every hunk, open the surrounding function with `read_file` (use `offset`/`limit`) and
`grep` for callers of anything whose signature or behaviour changed. Bugs hide at the
boundary between changed and unchanged code.

## 3. Hunt in this order

1. **Correctness** — wrong conditions, off-by-one, null/undefined paths, unhandled promise
   rejections, race conditions, resource leaks, mutated shared state, wrong units/time zones,
   error paths that swallow failures, behaviour changes callers don't expect.
2. **Security** — injection (SQL, shell, path traversal, template), authz checks missing on
   new endpoints, secrets in code or logs, unsafe deserialisation, SSRF in new fetches,
   permissive CORS, crypto misuse.
3. **Data & migrations** — irreversible migrations, missing indexes on new query paths,
   backwards-incompatible schema/API changes.
4. **Performance** — N+1 queries, quadratic loops over user-sized input, sync I/O on hot
   paths, unbounded caches/queues.
5. **Tests** — is the new behaviour covered? Do tests assert the right thing or merely run?
6. **Maintainability** — only when it materially hurts: duplicated logic that will drift,
   misleading names, dead code. Skip pure taste.

## 4. Verify before reporting

For each candidate finding, trace a concrete path: *which input, through which caller,
produces which wrong result*. If you can, prove it — run the test suite, write a failing
test, or execute a tiny snippet with `execute_code`. Drop anything you cannot substantiate,
or label it clearly as a question.

## 5. Report

Group by severity and keep each finding to a few lines:

```
🔴 Blocking — src/auth/session.ts:84
   `expiresAt` is compared in seconds but set in ms, so every session is treated as
   expired after ~16 minutes. Repro: login → wait 20 min → 401. Fix: use Date.now()/1000.

🟡 Should fix — …
⚪ Nit (optional) — …
```

End with a one-line verdict (approve / approve with nits / request changes) and what you ran
to verify (tests, linters, manual repro). Never claim tests pass unless you ran them.
