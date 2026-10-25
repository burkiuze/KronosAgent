---
name: data-visualization
description: Choose the right chart and produce clean, accessible visualisations (matplotlib/plotly PNG or interactive HTML) from data — trends, comparisons, distributions, compositions. Use when asked to plot, chart, graph or visualise data, or to build a small dashboard.
version: 1.0.0
category: data
tags: [charts, matplotlib, plotly, dashboard, visualization]
requires:
  toolsets: [code, files]
---

# Data visualisation

## Pick the form by the question

| Question | Chart |
|---|---|
| Change over time | line (bars if few periods) |
| Compare categories | horizontal bar, sorted |
| Part of whole (≤5 parts) | stacked bar; avoid pies beyond 3 slices |
| Distribution | histogram / box / violin |
| Relationship | scatter (+ trend line) |
| One headline number | big-number tile, not a chart |

Never use dual y-axes; use two aligned charts instead. Never 3D.

## Make it readable

- Title states the takeaway ("Signups doubled after the March launch"), subtitle the scope.
- Label axes with units; start bar axes at zero; thin gridlines; no chart junk.
- Direct-label series instead of a distant legend when ≤4 series.
- Colour: one accent for the focus, greys for context; colour-blind-safe palettes
  (e.g. Okabe–Ito); never encode meaning by colour alone.
- Sort categories meaningfully; cap at ~10 categories (group the rest as "Other").

## Produce

- Static: matplotlib → `plt.savefig("chart.png", dpi=200, bbox_inches="tight")`, then show it
  with `view_image` to check for overlapping labels before handing it over.
- Interactive: plotly → `fig.write_html("chart.html", include_plotlyjs="cdn")` and register
  it with `artifact_create` so it opens in the Artifacts view.
- Include the data table (or CSV) alongside, so numbers can be checked.
