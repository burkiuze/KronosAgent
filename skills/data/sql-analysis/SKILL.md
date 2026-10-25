---
name: sql-analysis
description: Write, explain and optimise SQL for analysis across Postgres, MySQL, SQLite, BigQuery, Snowflake and DuckDB — CTEs, window functions, cohort/funnel/retention queries — and run them safely. Use for database questions, query writing or slow-query tuning.
version: 1.0.0
category: data
tags: [sql, postgres, duckdb, analytics, query]
requires:
  toolsets: [shell, code]
---

# SQL analysis

## Safety

Read-only by default. Never run `UPDATE`/`DELETE`/`DROP`/`ALTER` without explicit user
confirmation and a `WHERE` you've previewed with `SELECT count(*)`. Prefer a read replica or
a local copy. Add `LIMIT` while exploring.

## Explore the schema first

Postgres: `\dt`, `\d table` or `information_schema.columns`; SQLite: `.schema`;
BigQuery: `INFORMATION_SCHEMA.COLUMNS`. Check grain (one row = what?), keys, and time zones.

Local files: DuckDB queries CSV/Parquet directly — `duckdb -c "SELECT * FROM 'data.csv' LIMIT 5"`.

## Write readable SQL

- CTEs for each logical step; meaningful names; one column per line in long selects.
- Explicit `JOIN … ON`; watch for fan-out (row counts before/after joins).
- `COUNT(DISTINCT user_id)` for people, `COUNT(*)` for events — say which.
- Window functions for running totals, ranks, period-over-period:
  `LAG(revenue) OVER (PARTITION BY region ORDER BY month)`.
- Handle NULLs deliberately (`COALESCE`, `NULLIF(x,0)` before division).

## Common patterns

- **Cohort retention**: first-activity month per user → activity months → diff in months → pivot.
- **Funnel**: per user, min timestamp per step, require ordering, count users reaching each step.
- **Dedup latest**: `ROW_NUMBER() OVER (PARTITION BY id ORDER BY updated_at DESC) = 1`.

## Performance

`EXPLAIN ANALYZE`; filter early; index join/filter columns; avoid functions on indexed
columns in `WHERE`; partition pruning on date columns in warehouses; select only needed
columns (column stores bill by bytes scanned).

Report results with the query used, so they can be re-run.
