---
name: deep-research
description: Research a question across many sources and synthesise a cited, balanced report — markets, technologies, history, comparisons, literature reviews, "what's the state of X". Fans out parallel researcher subagents for breadth, then cross-checks and writes the report as an artifact.
version: 1.3.0
category: research
tags: [research, report, citations, comparison, analysis]
requires:
  toolsets: [web, delegate, artifacts]
---

# Deep research

## 1. Frame

Restate the question, the decision it informs, the audience and the time horizon. If the
scope is genuinely ambiguous (e.g. which market, which region), ask **one** clarifying
question with `ask_user`; otherwise state your assumptions and proceed.

Break it into 3–6 sub-questions that together answer the whole. Put them in `todo_write`.

## 2. Fan out

Run sub-questions in parallel with `delegate` (`agent: researcher`, one task per
sub-question). Each brief must say: the sub-question, what evidence counts (primary sources,
data, dates), and to return **claims with URLs and publication dates**.

For small questions, do it yourself: 3–5 `web_search` queries with varied phrasing
(include the year, synonyms, "vs", "benchmark", "report", site-specific queries such as
`site:arxiv.org`, `site:gov`), then `web_fetch` the best 5–10 sources.

## 3. Evaluate sources

Prefer primary (papers, filings, official docs, datasets, statistics offices) over secondary
(news, blogs) over tertiary (aggregators). Note date, author, incentives. Discard SEO filler.
For contested facts, find at least two independent sources; record disagreements rather
than averaging them away.

## 4. Synthesise

- Lead with the answer (executive summary: 3–6 bullets).
- Then sections per sub-question, each claim followed by a citation `[n]`.
- Include numbers with units and dates; tables for comparisons.
- A "Confidence & gaps" section: what is uncertain, what would change the conclusion.
- Sources list: `[n] Title — Publisher, YYYY-MM-DD — URL`.

## 5. Deliver

Save the report with `artifact_create` (markdown) and give the user the summary inline with a
pointer to the artifact. If the user will repeat this research, offer to schedule a refresh
with `cron_create`.

Never invent citations. If you couldn't access a source, say so.
