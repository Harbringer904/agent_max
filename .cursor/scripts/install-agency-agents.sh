#!/usr/bin/env bash
# Install project Agency Agents into Cursor user dirs (all repos on this machine).
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../agents" && pwd)"
DEST_CURSOR="${CURSOR_AGENTS_DIR:-$HOME/.cursor/agents}"
DEST_CLAUDE="${CLAUDE_AGENTS_DIR:-$HOME/.claude/agents}"
mkdir -p "$DEST_CURSOR" "$DEST_CLAUDE"
count=0
for f in "$SRC"/*.md; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  cp -f "$f" "$DEST_CURSOR/$base"
  claude_dest="$DEST_CLAUDE/$base"
  if [ -L "$claude_dest" ]; then
    claude_dest="$DEST_CLAUDE/agency-$base"
  fi
  if [ -L "$claude_dest" ]; then
    continue
  fi
  cp -f "$f" "$claude_dest"
  count=$((count + 1))
done
echo "Installed $(ls -1 "$DEST_CURSOR"/*.md | wc -l) Cursor subagents -> $DEST_CURSOR"
echo "Claude mirrors written: $count -> $DEST_CLAUDE"
