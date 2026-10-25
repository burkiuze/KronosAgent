---
name: performance-profiling
description: Measure and fix slow code, high memory, slow builds, slow queries or slow pages using profilers and benchmarks before optimising. Use for "it's slow", latency/throughput targets, memory leaks, bundle size, or "optimise this".
version: 1.0.0
category: engineering
tags: [performance, profiling, benchmark, latency, memory]
requires:
  toolsets: [shell, files]
---

# Performance profiling

**Measure → find the hotspot → change one thing → measure again.** Never optimise blind.

## Define the target

What metric (p50/p95 latency, throughput, RSS, build time, bundle KB, TTI), on what input,
what goal? Write it in a todo. Build a repeatable benchmark first.

## Tools by stack

| Stack | CPU | Memory | Bench |
|---|---|---|---|
| Node | `node --cpu-prof app.js` (open .cpuprofile), `clinic flame`, `0x` | `--heapsnapshot-signal`, `--inspect` heap snapshots | `hyperfine`, `tinybench`, `autocannon` for HTTP |
| Python | `py-spy record -o prof.svg -- python app.py`, `cProfile` + `snakeviz` | `tracemalloc`, `memray` | `pytest-benchmark`, `timeit` |
| Go | `pprof` (`go test -cpuprofile`), `net/http/pprof` | `pprof -alloc_space` | `go test -bench . -benchmem` |
| Rust | `cargo flamegraph`, `perf` | `heaptrack`, `dhat` | `criterion` |
| JVM | async-profiler, JFR | JFR, `jmap -histo` | JMH |
| SQL | `EXPLAIN (ANALYZE, BUFFERS)` (Postgres), `EXPLAIN ANALYZE` (MySQL) | — | `pgbench` |
| Web | Lighthouse, Chrome Performance panel (`browser` tool) | heap snapshots | WebPageTest |

`hyperfine 'cmd-a' 'cmd-b'` is the quickest honest comparison for CLI commands.

## Usual suspects (check in order)

1. Algorithmic: nested loops over large inputs, repeated linear searches → maps/sets/indexes.
2. I/O: N+1 queries, chatty network calls → batch, join, cache, parallelise.
3. Missing DB indexes; `SELECT *` over wide rows; unbounded result sets.
4. Serialisation/parsing in hot loops; regex compiled per call.
5. Sync I/O or CPU work blocking an event loop.
6. Allocation churn; unbounded caches/listeners (leaks).
7. Front-end: huge bundles (`vite build --report`/`source-map-explorer`), unvirtualised long
   lists, layout thrash, unoptimised images.

## Report

Before/after numbers from the same benchmark, the hotspot evidence (profile excerpt), the
change, and any trade-offs (memory vs speed, staleness for caches).
