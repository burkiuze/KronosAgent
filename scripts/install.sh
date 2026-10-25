#!/usr/bin/env bash
# KRONOS AGENT installer — clones (or updates) Kronos into ~/.kronos/app, builds it and puts
# `kronos` on your PATH.  usage:
#   curl -fsSL https://raw.githubusercontent.com/burkiuze/KronosAgent/main/scripts/install.sh | bash
# env: KRONOS_DIR (install dir), KRONOS_REF (branch/tag, default main), KRONOS_BIN (bin dir)
set -euo pipefail

REPO="${KRONOS_REPO:-https://github.com/burkiuze/KronosAgent.git}"
REF="${KRONOS_REF:-main}"
DIR="${KRONOS_DIR:-$HOME/.kronos/app}"
BIN="${KRONOS_BIN:-$HOME/.local/bin}"

gold=$'\033[38;5;178m'; dim=$'\033[2m'; red=$'\033[31m'; off=$'\033[0m'
say() { printf '%s⏳%s %s\n' "$gold" "$off" "$*"; }
die() { printf '%s✗ %s%s\n' "$red" "$*" "$off" >&2; exit 1; }

command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "Node.js 20.19+ is required — https://nodejs.org (or: nvm install 22)"
major="$(node -p 'process.versions.node.split(".")[0]')"
minor="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$major" -lt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -lt 19 ]; }; then
  die "Node.js 20.19+ is required (found $(node -v)). Node 22+ recommended (built-in SQLite)."
fi

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" fetch --depth 1 origin "$REF"
  git -C "$DIR" checkout -q FETCH_HEAD
else
  say "Cloning Kronos into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
fi

say "Installing dependencies"
(cd "$DIR" && npm install --no-audit --no-fund --loglevel=error)
say "Building"
(cd "$DIR" && npm run build --silent)

mkdir -p "$BIN"
ln -sf "$DIR/packages/cli/dist/bin.js" "$BIN/kronos"
chmod +x "$DIR/packages/cli/dist/bin.js"

printf '\n%s KRONOS AGENT installed%s → %s/kronos\n' "$gold" "$off" "$BIN"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) printf '%sAdd it to your PATH:%s  echo '"'"'export PATH="%s:$PATH"'"'"' >> ~/.%src\n' "$dim" "$off" "$BIN" "$(basename "${SHELL:-bash}")" ;;
esac
printf '\n  kronos setup     %s# pick a model & add keys (or skip for offline demo mode)%s\n' "$dim" "$off"
printf '  kronos           %s# chat in the terminal%s\n' "$dim" "$off"
printf '  kronos web       %s# the desktop UI in your browser%s\n\n' "$dim" "$off"
