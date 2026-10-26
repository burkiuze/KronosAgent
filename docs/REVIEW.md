# Code review

Kronos reviews code the way a careful senior engineer does: it reads every changed file with
its context, reports only problems the author would want to fix, and checks its own findings
before showing them. It works on your uncommitted changes, a branch, a commit, a patch or a
GitHub pull request — from the terminal, in a chat, in CI or as a bot on GitHub.

```bash
kronos review                      # uncommitted changes (staged, unstaged and new files)
kronos review --base main          # everything since the merge base with main
kronos review --commit HEAD~1
kronos review --pr 42 --post       # review pull request #42 and post inline comments
kronos review --format sarif --out review.sarif --fail-on high   # CI
```

In a chat: `/review`, `/review main`, `/review #42`, or just ask ("review my changes"). On
GitHub: comment `@kronos review` on a pull request (anything after it is passed on as focus,
e.g. `@kronos review — check the migration`), or set `github.bot.autoReview: true` to review every
new pull request.

## How it works

1. **Collect the diff.** For a branch, `git diff base...head` (changes since the merge base, as
   in a pull request). For a pull request, a throwaway `git worktree` at its head commit, removed
   afterwards — your checkout is never touched.
2. **Select files** — without a model call. Binary, data, lock, generated and vendored files are
   set aside, and so are paths that may hold secrets (`.env`, keys, credentials): they are never
   sent to the model. Files with more than `review.maxFileLines` changed lines are listed but not
   reviewed. Everything set aside is reported with the reason.
3. **Group** related files (deterministically): tests go with the code they test, files of the
   same area stay together, at most `review.maxFilesPerGroup` files and about
   `review.maxGroupLines` changed lines per group.
4. **Review each group in parallel** with a read-only agent (read, grep, glob, repo map — no
   shell, no writes). It gets the diff with new-side line numbers, general and per-language defect
   checklists, the project's review rules, the other files of the change, and for large groups a
   short plan of the riskiest spots. It records each finding with `review_comment` (quoting the
   code it is about) and finishes with `review_done`; if it skips a file of its group it is sent
   back once. Models without tool calling may answer with JSON instead.
5. **Place every finding** on the code it quotes, not on the line number the model guessed:
   matched ignoring indentation, first in the diff, then in the file, then — if the quote is in
   exactly one other changed file — there. Findings that cannot be tied to the change are dropped.
6. **Merge duplicates** (same place, same problem), keeping the most severe.
7. **Fact-check.** A separate pass tries to *refute* each finding against the code around it.
   It may drop one only when (A) the code it describes is not there, (B) a line it quotes already
   prevents the problem, (C) it is about code the change does not touch, or (D) it is purely a
   matter of taste. Security, concurrency, compatibility and reliability findings can only be
   dropped on A or B. It may lower a severity, never raise it. Findings it confirms are marked
   *verified*.
8. **Report** with a verdict: *not ready to merge* when a high or critical problem remains.

## What counts as a finding

A finding has to matter (correctness, security, reliability, performance, maintainability), be
one discrete problem with a fix, be introduced by this change, come with the concrete input or
caller that triggers it, and be something the author would fix. Formatting and naming taste are
ignored unless a project rule asks for them. Severity:

| | |
|---|---|
| critical | data loss, a security hole or a crash on common paths |
| high | wrong behavior users will hit |
| medium | edge-case bugs and risky patterns |
| low | minor issues |

## Project rules

Kronos reads, from the repository root:

- `REVIEW.md` (or `.kronos/review.md`, `.github/REVIEW.md`, `docs/REVIEW.md`) — rules for every file;
- the review-related sections (headings mentioning review, conventions, rules, guidelines, style,
  security…) of `AGENTS.md`, `CLAUDE.md`, `KRONOS.md` and `.github/copilot-instructions.md`;
- `.kronos/review/*.md` with `paths` front matter for rules that apply to part of the code:

  ```markdown
  ---
  paths: ["src/api/**", "src/auth/**"]
  ---
  Every handler checks the session before reading the body.
  Money is integer cents; never use floats.
  ```

A finding that relies on a rule cites the file it came from.

## Output

| `--format` | |
|---|---|
| `text` (default) | colored terminal report |
| `markdown` | the report as Markdown (also the body of GitHub reviews) |
| `json` | findings with paths, lines, severity, category, confidence, suggestion, verified flag; also dropped findings with reasons |
| `sarif` | SARIF 2.1.0 for GitHub code scanning and IDEs, with fixes for suggestions |
| `github` | the exact pull request review payload |

On GitHub, findings on changed lines become inline comments; a finding with an exact replacement
carries a `suggestion` block the author can apply with one click. Findings outside the changed
lines go into the review body. Kronos never approves a pull request; `--request-changes` asks for
changes when the verdict is negative.

`--fail-on <severity>` makes the command exit with 1 when such a finding remains — use it as a CI
gate. `--show-dropped` lists what the fact-checker removed and why.

## Cost and speed

Selection, grouping, placement and deduplication cost nothing. Each group is one reviewer run;
`review.concurrency` (default 3) bounds how many run at once, and the fact-check is one short
call per ten findings. Use a cheaper `review.model` for routine reviews and the strongest model
for important ones; `review.verifyModel` can differ from the reviewer's.
