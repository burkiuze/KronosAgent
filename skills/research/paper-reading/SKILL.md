---
name: paper-reading
description: Read and explain academic papers (arXiv, PDFs, DOIs) — contributions, method, results, limitations — at the level the user needs, and compare with related work. Use when given a paper link/PDF or asked to summarise research.
version: 1.0.0
category: research
tags: [papers, arxiv, academic, summary, ml]
requires:
  toolsets: [web, files]
---

# Paper reading

## Get the text

- arXiv: fetch the abstract page and the HTML version (`https://arxiv.org/html/<id>`) or PDF.
- Local PDF: `pdftotext -layout paper.pdf -` (poppler) or `python -c "import pypdf…"`
  (see the `pdf-tools` skill).
- DOI: resolve via `https://doi.org/<doi>`; look for an open-access version.

## Three passes

1. **Skim** (title, abstract, figures, conclusion): what problem, what claim?
2. **Method**: the core idea in one paragraph; assumptions; what's new vs prior work.
3. **Evidence**: datasets, baselines, metrics, ablations. Are comparisons fair (same compute,
   tuned baselines)? Statistical significance? Reproducibility (code, seeds)?

## Output template

```
## <Title> (<venue/year>)
**TL;DR** — one sentence.
**Problem** — …
**Key idea** — …
**Results** — headline numbers with the comparison point.
**Limitations / caveats** — including ones the authors don't state.
**Why it matters / who should care** — …
**Related** — 2–4 papers and how they differ.
```

Adapt depth to the user: explain jargon for newcomers; for experts, focus on deltas and
weaknesses. Quote equations only when they carry the idea.
