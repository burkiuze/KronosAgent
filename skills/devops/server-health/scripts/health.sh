#!/usr/bin/env bash
# Read-only health snapshot for Linux/macOS. usage: health.sh [path-for-du]
set -uo pipefail
path="${1:-/}"
hr() { printf '\n== %s ==\n' "$1"; }
os="$(uname -s)"

hr "host"
echo "$(hostname) · $(uname -sr) · up $(uptime | sed -E 's/.*up ([^,]*),.*/\1/')"
echo "load: $(uptime | sed -E 's/.*load averages?: //') · cpus: $(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"

hr "memory"
if [ "$os" = "Linux" ]; then free -h; else vm_stat | head -10; fi

hr "disk"
df -hP -x tmpfs -x devtmpfs -x overlay 2>/dev/null || df -hP
df -hP 2>/dev/null | awk 'NR>1 { gsub("%","",$5); if ($5+0 >= 85) print "WARNING: " $6 " is " $5 "% full" }'

hr "largest dirs under $path"
du -xh "$path" --max-depth=1 2>/dev/null | sort -h | tail -8 || du -h -d 1 "$path" 2>/dev/null | sort -h | tail -8

hr "top processes (cpu)"
ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -8 || ps aux -r | head -8
hr "top processes (memory)"
ps -eo pid,user,pcpu,pmem,comm --sort=-pmem 2>/dev/null | head -8 || ps aux -m | head -8

if command -v systemctl >/dev/null 2>&1; then
  hr "failed units"
  systemctl --failed --no-legend 2>/dev/null || true
fi

hr "listening ports"
(ss -tulpn 2>/dev/null || netstat -an 2>/dev/null | grep -i listen) | head -20

if command -v journalctl >/dev/null 2>&1; then
  hr "recent errors (journal, 1h)"
  journalctl -p 3 --since "1 hour ago" --no-pager 2>/dev/null | tail -15
fi
exit 0
