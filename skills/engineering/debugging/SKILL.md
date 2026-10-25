---
name: debugging
description: Systematically find the root cause of a bug, crash, failing test, flaky behaviour or wrong output. Use when something "doesn't work", a test fails, an error/stack trace is pasted, or behaviour differs between environments.
version: 1.1.0
category: engineering
tags: [debug, bug, failing-test, root-cause, stack-trace]
requires:
  toolsets: [files, shell]
---

# Debugging

Guessing is slow. Follow the loop: **reproduce → isolate → hypothesise → test → fix → guard.**

## 1. Reproduce

- Get the exact failing command, input and environment. Run it yourself with `shell` and
  capture the full output — never debug from a paraphrase.
- If it's flaky, loop it: `for i in $(seq 20); do <cmd> || echo FAIL $i; done`.
- No repro? Ask the user (`ask_user`) for logs, versions, and the last known good state.

## 2. Read the evidence

- Stack traces: start at the **deepest frame in our code**, not the top-most library frame.
- Error messages: `grep` the codebase for the literal message to find where it's thrown.
- Logs: look for the first anomaly *before* the failure, not the loudest line.

## 3. Isolate

- `git log -p -- <file>` and `git blame` around the failing line — what changed recently?
- `git bisect` when a regression has a known good commit:
  ```
  git bisect start; git bisect bad; git bisect good <sha>
  git bisect run <test command>
  ```
- Shrink the input until the bug disappears; the last thing you removed is the trigger.
- Write a minimal failing test as early as possible — it becomes the regression guard.

## 4. Hypothesis log

Keep a short list in a todo (`todo_write`): each hypothesis, the experiment that tests it,
and the result. Change **one variable at a time**. Add temporary logging/prints rather than
reasoning about values you haven't observed.

## 5. Fix the cause, not the symptom

- Ask "why" until the answer is in our control (5 whys).
- Prefer the smallest change that makes the invariant true at its source.
- Look for siblings: `grep` for the same pattern elsewhere.

## 6. Guard & clean up

- Keep the failing test (now passing). Remove debug prints.
- Run the full relevant test suite, not just the one test.
- Summarise: root cause, fix, how you verified, any follow-ups.

## Common culprits checklist

Off-by-one · stale cache/build artefacts (`rm -rf dist node_modules/.cache`) · env vars
missing in one environment · timezone/locale · floating point equality · async ordering /
missing `await` · mutable default arguments · case-sensitive filesystems · line endings ·
dependency version drift (`npm ls <pkg>`, lockfile diff) · permissions · port already in use.
