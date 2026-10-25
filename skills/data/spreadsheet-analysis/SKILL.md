---
name: spreadsheet-analysis
description: Load, clean, analyse and summarise CSV/TSV/Excel/Parquet data with Python (pandas) — profiling, pivots, joins, trends, anomalies — and export results. Use when the user shares a data file or asks questions about tabular data.
version: 1.1.0
category: data
tags: [csv, excel, pandas, analysis, data-cleaning]
requires:
  toolsets: [code, files]
---

# Spreadsheet analysis

## 1. Profile first

Run `python scripts/profile.py <file> [--sheet NAME]` (uses pandas; installs nothing). It
prints shape, dtypes, null rates, distinct counts, numeric summaries, top values and likely
key/date columns. Read it before answering anything — it reveals header rows, unit columns,
mixed types and duplicates.

If pandas is missing: `pip install pandas openpyxl pyarrow` (ask before installing in a
user environment you don't own).

## 2. Clean explicitly

Strip header junk/footers, normalise column names (`snake_case`), parse dates with an
explicit format, coerce numerics (`pd.to_numeric(errors="coerce")` then count what failed),
trim strings, dedupe on the real key. **Log every cleaning step** — the user must be able to
trust the numbers.

## 3. Analyse

- Answer the actual question with the simplest correct computation (groupby/pivot).
- Check totals reconcile with the raw data; sanity-check outliers before reporting them.
- Trends: resample by period; compare like-for-like periods; mention seasonality.
- Correlations are not causes — say so.

## 4. Present

- Lead with the answer and key numbers (with units and the period).
- Small tables in markdown; charts via matplotlib saved to PNG (see `data-visualization`).
- Export derived datasets to CSV/XLSX next to the input (never overwrite the original).

Use `execute_code` for multi-step analysis so intermediate variables persist between steps.
