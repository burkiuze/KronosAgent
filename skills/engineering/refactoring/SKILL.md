---
name: refactoring
description: Restructure code without changing behaviour — extract functions/modules, rename across a codebase, remove duplication, untangle dependencies, migrate APIs. Use for "clean up", "refactor", "split this file", "rename X everywhere", "modernise".
version: 1.0.0
category: engineering
tags: [refactor, cleanup, rename, architecture]
requires:
  toolsets: [files, shell]
---

# Refactoring

Behaviour must not change. Prove it with tests before and after.

## Before touching code

1. Run the tests and type-checker; record the baseline.
2. If the area is untested, add **characterisation tests** that pin current behaviour
   (even odd behaviour) first.
3. Map usages: `grep` for the symbol (word-boundary regex), including strings, configs,
   docs, templates and dynamic access (`obj[name]`, reflection, DI containers).

## Do it in small, verifiable steps

- One mechanical transformation per step: rename, move, extract, inline, change signature.
- Run tests after each step. If red, revert the step rather than debugging a pile.
- Prefer `multi_edit`/`apply_patch` for coordinated edits so a step is atomic.
- For wide renames, list every file first, then edit; re-`grep` at the end to confirm zero
  stale references.

## Catalogue

- *Extract function/module* when a block has a name-able purpose or is duplicated.
- *Introduce parameter object* when ≥4 params travel together.
- *Replace conditional with polymorphism/table* when a switch is repeated in several places.
- *Split phase* when a function both parses and processes.
- *Strangler fig* for big migrations: new path beside old, route gradually, delete old.

## Don't

- Mix refactoring with behaviour changes in one commit.
- Reformat untouched code (noisy diffs hide real changes).
- Introduce abstractions with a single implementation "for later".

## Done means

Tests and type-checks green, no new warnings, diff reviewed top to bottom, and a summary of
what moved where.
