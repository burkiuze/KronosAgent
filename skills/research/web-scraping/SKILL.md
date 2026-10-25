---
name: web-scraping
description: Extract structured data from websites — single pages, paginated listings, JS-rendered apps, APIs behind pages — politely and robustly, into CSV/JSON. Use for "scrape", "collect all X from this site", price/listing monitoring, or turning web pages into datasets.
version: 1.0.0
category: research
tags: [scraping, crawl, browser, extraction, data]
requires:
  toolsets: [web, browser, code]
---

# Web scraping

## Be a good citizen

Check `robots.txt` and the site's terms; prefer official APIs/exports/feeds when they exist.
Rate-limit (≥ 1 s between requests), identify with a sensible User-Agent, cache responses,
and never scrape behind logins/paywalls without the user's explicit right to do so. No
personal data harvesting.

## Pick the lightest tool that works

1. **Hidden API**: open the page with the `browser` tool and inspect network requests, or look
   for JSON in `<script id="__NEXT_DATA__">`/`application/ld+json`. Calling that JSON
   endpoint with `http_request` is faster and more stable than parsing HTML.
2. **Static HTML**: `web_fetch` (readable markdown) for one page; for many, a Python script with
   `httpx` + `selectolax`/`BeautifulSoup` via `execute_code`.
3. **JS-rendered**: the `browser` tool (Playwright) — wait for selectors, scroll for lazy
   loading, then extract.

## Robust extraction

- Select by stable attributes (`data-*`, ids, semantic tags) over brittle CSS paths.
- Validate each record (required fields present, types parse); count records per page.
- Pagination: follow "next" links or page params until empty; stop at a sane max.
- Normalise: trim whitespace, parse prices/dates with locale awareness, dedupe by URL/ID.

## Output

Save to CSV/JSON in the workspace, report counts and a sample, and note gaps/failures. For
recurring monitoring ("tell me when the price drops"), store the last snapshot and schedule a
`cron_create` job that diffs and only alerts on change.
