---
name: fact-check
description: Verify specific claims, statistics, quotes or news against reliable sources and give a verdict with evidence. Use for "is it true that…", checking a draft for factual errors, viral claims, or validating numbers before publishing.
version: 1.0.0
category: research
tags: [fact-check, verification, sources, misinformation]
requires:
  toolsets: [web]
---

# Fact-check

1. **Extract** each checkable claim as a precise statement (who, what, when, how much).
   Separate facts from opinions/predictions — only facts get verdicts.
2. **Trace to origin**: find the earliest/primary source (the study, dataset, filing,
   transcript, original post). Secondary reporting often mutates numbers.
3. **Corroborate** with at least one independent reliable source. Check dates: a true
   statistic from 2015 presented as current is *misleading*.
4. **Check context**: denominators, units, base rates, cherry-picked ranges, correlation
   vs causation, quote cropping.
5. **Verdict** per claim:
   `True` · `Mostly true` · `Misleading` (true but missing context) · `Unsupported` (no
   reliable evidence either way) · `False`.

Output a table: claim → verdict → one-line explanation → sources (with dates). Be explicit
about your confidence; prefer "Unsupported" to guessing.
