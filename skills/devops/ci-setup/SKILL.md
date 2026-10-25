---
name: ci-setup
description: Create or fix CI pipelines (GitHub Actions primarily; GitLab CI, CircleCI) — install, cache, lint, type-check, test matrix, build, release — and debug failing CI runs. Use for "set up CI", "add GitHub Actions", "CI is failing", release automation.
version: 1.0.0
category: devops
tags: [ci, github-actions, pipeline, release, automation]
requires:
  toolsets: [files, shell]
---

# CI setup

## Mirror what a developer runs

Read the project's scripts (package.json, Makefile, tox/nox, justfile). CI should run exactly
those: install → lint → type-check → test → build. Don't invent new commands.

## GitHub Actions template

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
permissions: { contents: read }
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: { node: [20, 22] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }}, cache: npm }
      - run: npm ci
      - run: npm run lint --if-present
      - run: npm run typecheck --if-present
      - run: npm test
```

Python: `actions/setup-python@v5` with `cache: pip`; Go: `actions/setup-go@v5`.
Least-privilege `permissions`, pinned action versions, secrets only via `secrets.*`,
`timeout-minutes` on long jobs.

## Debugging failures

1. Read the failing step's log from the first error, not the last line.
2. Reproduce locally with the same versions (Node/Python from the matrix, `npm ci` not
   `npm install`, clean checkout).
3. Classic causes: lockfile drift, missing env/secret, OS differences (case-sensitive paths,
   line endings), time zones, tests depending on order or network, cache poisoning.
4. Fix the cause; don't add retries or skip tests to get green.

## Releases

Tag-triggered workflow building artefacts and publishing (npm with provenance, GitHub
Releases, container registry); changelog via the `release-notes` skill.
