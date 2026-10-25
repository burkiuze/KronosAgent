---
name: codebase-onboarding
description: Rapidly understand an unfamiliar repository — stack, entry points, build/test commands, architecture, conventions — and write it down as KRONOS.md/ARCHITECTURE notes. Use for "explain this codebase", "where do I start", "how is this organised", or before a large change in a new repo.
version: 1.1.0
category: engineering
tags: [onboarding, architecture, explore, documentation]
requires:
  toolsets: [files, shell]
---

# Codebase onboarding

Goal: in a few minutes, be able to answer *what is this, how do I run it, where does X live,
and what are the rules here?* — and leave notes so the next session starts warm.

## 1. Survey (parallel, cheap)

Delegate in parallel when the repo is large (`delegate` with `agent: explorer`), otherwise:

- `list_dir` the root (depth 2). Note manifests: `package.json`, `pyproject.toml`, `go.mod`,
  `Cargo.toml`, `pom.xml`, `Gemfile`, `composer.json`, `Dockerfile`, `docker-compose.yml`,
  `Makefile`, `.github/workflows/*`.
- `read_file` README, CONTRIBUTING, any `AGENTS.md`/`CLAUDE.md`/`KRONOS.md`.
- `git log --oneline -20` and `git shortlog -sn | head` for activity and owners.
- Size: `git ls-files | wc -l`, top languages: `git ls-files | sed 's/.*\.//' | sort | uniq -c | sort -rn | head`.

## 2. Find the spine

- Entry points: `main`, `bin`, `scripts` in manifests; `cmd/`, `src/main.*`, `app.py`,
  `server.*`, `index.*`; framework conventions (Next.js `app/`, Django `urls.py`, Rails `config/routes.rb`).
- Follow one request/command end-to-end through the layers; note each hop (file:line).
- Data model: migrations, ORM models, schema files, protobuf/OpenAPI specs.

## 3. Learn to run it

Find and *try* the install, build, test and lint commands (CI workflow files are the most
reliable source). Note what failed and why (missing env vars, services).

## 4. Conventions

Formatting/linting configs, test layout, error-handling style, logging, dependency injection,
naming. These become rules you follow when editing.

## 5. Write it down

Create or update `KRONOS.md` at the repo root (Kronos loads it into every session in this
project) with:

```
# <Project> — notes for agents
## Commands      install / dev / test / lint / build
## Layout        dir → purpose (one line each)
## Architecture  request flow, key modules, data stores
## Conventions   style, testing, error handling, do/don't
## Gotchas       env vars, flaky tests, generated files not to edit
```

Keep it under ~150 lines; link to deeper docs instead of copying them. Tell the user what
you wrote.
