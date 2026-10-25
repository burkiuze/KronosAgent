---
name: server-health
description: Check the health of a Linux/macOS machine or server — CPU, memory, disk, load, top processes, failing services, open ports, recent errors, certificate expiry — and set up scheduled monitoring with alerts to chat. Use for "is my server ok", "why is it slow", "disk full", uptime monitoring.
version: 1.0.0
category: devops
tags: [monitoring, linux, server, disk, alerts]
requires:
  toolsets: [shell]
---

# Server health

## Snapshot

Run `bash scripts/health.sh` (read-only; works on Linux and macOS). It reports uptime/load,
memory, disk usage (flags > 85%), largest directories under a path, top CPU/memory processes,
failed systemd units, listening ports and recent kernel/journal errors.

For remote servers use the SSH terminal backend (Settings → Workspace → Terminal backend → SSH) or
`ssh host 'bash -s' < scripts/health.sh`.

## Interpret

- Load average consistently > CPU count → CPU saturation; check top processes.
- Low "available" memory + swap activity → memory pressure; look for leaks or oversized caches.
- Disk > 90% → find culprits: `du -xh / --max-depth=2 | sort -h | tail`, old logs
  (`journalctl --vacuum-time=7d`), Docker (`docker system df`, `docker system prune` — confirm first).
- Failed units → `systemctl status <unit>` and `journalctl -u <unit> -n 100`.
- TLS: `echo | openssl s_client -connect host:443 2>/dev/null | openssl x509 -noout -enddate`.

## Monitor

Offer a `cron_create` job (e.g. every 30 minutes) that runs the script and **only messages
when a threshold is crossed** (disk > 85%, failed units, cert < 14 days), delivered to the
user's Telegram/Slack. Silence is the healthy state.

Never kill processes, delete files or restart services without confirmation.
