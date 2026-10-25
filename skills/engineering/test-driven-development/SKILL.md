---
name: test-driven-development
description: Implement features or fixes test-first (red → green → refactor), choosing the project's existing test framework. Use when asked to add tests, use TDD, improve coverage, or when a change is risky enough to need a safety net.
version: 1.0.0
category: engineering
tags: [tdd, testing, unit-tests, coverage]
requires:
  toolsets: [files, shell]
---

# Test-driven development

## Find the harness first

Look before you invent: `package.json` scripts (`vitest`, `jest`, `mocha`), `pyproject.toml`
/ `pytest.ini`, `go test`, `cargo test`, `Gemfile` (rspec/minitest), `pom.xml`/`build.gradle`.
Mirror the location and naming of existing tests (`*.test.ts`, `test_*.py`, `*_test.go`).
Run the existing suite once to learn the baseline (and so you don't blame yourself for
pre-existing failures).

## The loop

1. **Red** — write the smallest test that expresses the next behaviour. Run it and *see it
   fail for the right reason* (assertion, not import error).
2. **Green** — write the simplest code that passes. Resist generalising.
3. **Refactor** — remove duplication, improve names, with the tests green after each step.
4. Commit (or checkpoint) at green. Repeat.

## What good tests look like

- One behaviour per test; the name reads as a sentence: `rejects expired tokens`.
- Arrange / Act / Assert, with no logic (loops, conditionals) in the test body.
- Deterministic: freeze time, seed randomness, no real network — use fakes at the boundary.
- Assert on outputs and observable effects, not on private implementation details.
- Cover edges: empty, one, many, max size, unicode, negative, null, concurrent.

## Bug fixes

Always reproduce the bug as a failing test before fixing it. The test name should
describe the bug ("does not double-charge when retrying a timed-out payment").

## Finish

Run the whole suite plus linters/type-checkers the project uses. Report the commands you ran
and their results honestly.
