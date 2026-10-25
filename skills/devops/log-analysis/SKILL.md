---
name: log-analysis
description: Analyse application, web-server, system or CI logs to find errors, patterns, spikes and root causes — grouping similar lines, building timelines and correlating across services. Use when given log files/output or asked "what happened at 3am", "why are we getting 500s".
version: 1.0.0
category: devops
tags: [logs, errors, incident, observability, grep]
requires:
  toolsets: [shell, files]
---

# Log analysis

## Orient

Size and time range first: `wc -l`, `head -3`, `tail -3`. Identify format (JSON lines, nginx
combined, syslog, logfmt). For JSON logs use `jq`: `jq -r 'select(.level=="error") | [.time,.msg] | @tsv'`.

## Find the signal

- Error volume over time (spot the spike):
  `grep -E 'ERROR|FATAL| 5[0-9]{2} ' app.log | cut -c1-16 | uniq -c` (adapt the timestamp slice).
- Group similar errors by normalising variable parts:
  `grep ERROR app.log | sed -E 's/[0-9a-f-]{8,}/<id>/g; s/[0-9]+/<n>/g' | sort | uniq -c | sort -rn | head`.
- nginx/apache: status distribution `awk '{print $9}' access.log | sort | uniq -c`; slowest
  endpoints if `$request_time` is logged; top clients `awk '{print $1}' | sort | uniq -c | sort -rn | head`.
- The **first** occurrence matters more than the most frequent: `grep -n -m1 '<pattern>'`.

## Correlate

Build a timeline: deploys (`git log --since`), config changes, cron jobs, traffic spikes,
dependency outages. Follow request/trace IDs across services.

## Report

What happened (timeline), impact (window, error rate, affected endpoints/users), most likely
root cause with the evidence lines (quoted with timestamps), and recommended fixes/alerts.
Redact secrets, tokens and personal data from any quoted lines.
