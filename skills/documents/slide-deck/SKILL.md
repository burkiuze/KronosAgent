---
name: slide-deck
description: Build presentation slide decks as self-contained HTML (reveal.js) or Markdown (Marp) — outline, narrative, visuals, speaker notes — and export to PDF/PPTX. Use for "make slides", pitch decks, talk decks or turning a document into a presentation.
version: 1.0.0
category: documents
tags: [slides, presentation, reveal.js, marp, pitch]
requires:
  toolsets: [files, artifacts]
---

# Slide decks

## Story first

1. Audience, goal, duration (≈1 slide per minute).
2. Write the **headline of every slide as a full sentence** — the deck should read as a story
   from the titles alone (situation → complication → resolution, or problem → solution →
   proof → ask for pitches).
3. One idea per slide; ≤ 30 words of body text; move detail to speaker notes.

## Build (pick one)

- **reveal.js single HTML file** (best for the Artifacts view): load reveal from a CDN,
  `<section>` per slide, `<aside class="notes">` for speaker notes, a theme with large type
  (≥ 28px body), consistent colours. Save as `deck.html` and register it with
  `artifact_create` (kind `html`).
- **Marp markdown**: `---` between slides, `marp deck.md --pdf` / `--pptx` to export
  (`npx @marp-team/marp-cli`).

## Visuals

Charts from data (see `data-visualization`), diagrams via Mermaid, images from
`generate_image` when illustrative art helps. Big numbers beat tables; tables beat paragraphs.

## Check

Open it with the `browser` tool and screenshot a few slides to catch overflow. Give the user
the file path plus how to present/export.
