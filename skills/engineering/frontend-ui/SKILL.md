---
name: frontend-ui
description: Build or polish web front-ends (React/Vue/Svelte/plain HTML+CSS, Tailwind) — layouts, components, responsive design, accessibility, dark mode, forms and state — and verify visually in a real browser. Use for UI implementation, landing pages, dashboards, "make it look better", or fixing layout bugs.
version: 1.0.0
category: engineering
tags: [frontend, react, css, tailwind, accessibility, ui]
requires:
  toolsets: [files, shell, browser]
---

# Front-end UI

## Fit the codebase

Use the existing framework, component library, styling approach (CSS modules, Tailwind,
styled-components) and design tokens. Find an existing similar component and copy its
patterns before creating new ones.

## Layout & visual quality

- Spacing on a scale (4/8 px multiples); consistent radii and shadows; limited type scale
  (e.g. 12/14/16/20/24/32) with clear hierarchy.
- Flexbox for 1-D, Grid for 2-D layouts; avoid fixed heights; `min-width: 0` on flex children
  that must truncate.
- Responsive: mobile-first, test at 375, 768, 1280, 1920 px widths; no horizontal scroll.
- Colours from tokens with contrast ≥ 4.5:1 for text; dark mode via CSS variables.
- States for everything interactive: hover, focus-visible, active, disabled, loading, empty,
  error.

## Accessibility

Semantic elements (`button`, `nav`, `main`, `label`), keyboard reachability and visible focus,
`alt` text, `aria-*` only when semantics can't express it, respect `prefers-reduced-motion`,
form errors linked to fields.

## State & data

Keep state as local as possible; derive instead of duplicating; handle loading/error/empty
for every async call; optimistic updates only with rollback.

## Verify in a browser

Run the dev server, open the page with the `browser` tool, take screenshots at mobile and
desktop widths, check the console for errors, and tab through the page. Fix what you see —
then show the user the screenshots.
