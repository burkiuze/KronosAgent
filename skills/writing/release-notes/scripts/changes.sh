#!/usr/bin/env bash
# Print commits between two refs grouped by Conventional Commit type.
# usage: changes.sh [from] [to]   (from defaults to the latest tag, to defaults to HEAD)
set -euo pipefail
to="${2:-HEAD}"
from="${1:-$(git describe --tags --abbrev=0 "$to" 2>/dev/null || git rev-list --max-parents=0 "$to" | tail -1)}"
echo "# Changes ${from}..${to}"
git log --no-merges --format='%s%x09%an%x09%h' "${from}..${to}" | awk -F'\t' '
{
  subj=$1; type="other"
  if (match(subj, /^[a-z]+(\([^)]*\))?!?:/)) {
    head=substr(subj, 1, RLENGTH-1); type=head; sub(/\(.*$/, "", type); sub(/!$/, "", type)
    if (head ~ /!$/ || subj ~ /BREAKING/) type="breaking"
  }
  lines[type]=lines[type] "- " subj " (" $2 ", " $3 ")\n"
}
END {
  n=split("breaking feat fix perf refactor docs test build ci chore other", order, " ")
  for (i=1;i<=n;i++) if (order[i] in lines) printf "\n## %s\n%s", order[i], lines[order[i]]
}'
