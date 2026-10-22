#!/usr/bin/env bash
# memory_inputs.sh — gather what a memory review needs in one call.
#
# Usage: memory_inputs.sh [memory_dir] [daily_days]
#   memory_dir   default: ./memory
#   daily_days   how many days of daily files to list (default 3)
#
# Layout assumed:
#   <memory_dir>/MEMORY.md             index; one "- [Title](file.md) — hook" line per file
#   <memory_dir>/daily/YYYY-MM-DD.md   chronological notes
#   <memory_dir>/*.md                  topic files
#
# Prints: recent daily files, every topic file with age and size, index entries
# that point at missing files, and topic files the index doesn't mention.
set -euo pipefail

DIR="${1:-memory}"
DAYS="${2:-3}"
[[ -d "$DIR" ]] || { echo "No memory directory at $DIR"; exit 1; }

age_days() {  # days since last modification, portable across macOS and Linux
  local mtime now
  mtime="$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1")"
  now="$(date +%s)"
  echo $(( (now - mtime) / 86400 ))
}

echo "== Daily files, last $DAYS days =="
for ((i = 0; i < DAYS; i++)); do
  d="$(date -v-"${i}"d +%F 2>/dev/null || date -d "-${i} day" +%F)"
  f="$DIR/daily/$d.md"
  if [[ -f "$f" ]]; then
    echo "$f  ($(wc -l < "$f" | tr -d ' ') lines)"
  else
    echo "$f  (missing)"
  fi
done

echo
echo "== Topic files =="
for f in "$DIR"/*.md; do
  [[ "$(basename "$f")" == "MEMORY.md" ]] && continue
  printf '%s  age=%sd  %s bytes\n' "$f" "$(age_days "$f")" "$(wc -c < "$f" | tr -d ' ')"
done

INDEX="$DIR/MEMORY.md"
if [[ -f "$INDEX" ]]; then
  echo
  echo "== Index entries pointing at missing files =="
  grep -oE '\]\([^)]+\.md\)' "$INDEX" | sed -E 's/^\]\((.*)\)$/\1/' | sort -u | while read -r rel; do
    [[ -f "$DIR/$rel" ]] || echo "$rel"
  done

  echo
  echo "== Topic files not mentioned in the index =="
  for f in "$DIR"/*.md; do
    b="$(basename "$f")"
    [[ "$b" == "MEMORY.md" ]] && continue
    grep -q "$b" "$INDEX" || echo "$b"
  done
else
  echo
  echo "No $INDEX — the review should create one."
fi
