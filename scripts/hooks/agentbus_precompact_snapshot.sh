#!/usr/bin/env bash
# Deployed into a pool agent's own project directory as
# scripts/hooks/agentbus_precompact_snapshot.sh (a symlink back to this file
# is the recommended setup) and wired into that project's
# .claude/settings.json as a PreCompact hook. Lives in this repo alongside
# the other pool-pane hooks for the same reason, though unlike them it never
# calls any AgentBus HTTP endpoint — it's a Claude-Code-native safety net for
# a pool agent's own memory system, not a bus-core integration.
#
# PreCompact safety net: Claude Code's auto-compaction can discard transcript
# content before AgentBus's own journaling sweep ever sees it. This hook
# copies the about-to-be-compacted transcript to a raw snapshot file, and
# leaves exactly one pointer line in today's daily journal — it never writes
# conversation content into the curated journal itself, that stays the
# agent's own hand-written prose.
#
# Fails silently throughout: must never block compaction.

set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SNAPSHOT_DIR="$PROJECT_DIR/memory/precompact-snapshots"
DAILY_DIR="$PROJECT_DIR/memory/daily"

INPUT="$(cat)"
TRANSCRIPT_PATH="$(jq -r '.transcript_path // empty' <<<"$INPUT")"
SESSION_ID="$(jq -r '.session_id // "unknown"' <<<"$INPUT")"

[[ -n "$TRANSCRIPT_PATH" && -f "$TRANSCRIPT_PATH" ]] || exit 0

mkdir -p "$SNAPSHOT_DIR" "$DAILY_DIR" 2>/dev/null || exit 0

TS="$(date +%s)"
SNAPSHOT_FILE="$SNAPSHOT_DIR/${SESSION_ID}-${TS}.jsonl"

# Cap at the last 500 lines — enough to cover what compaction is about to
# discard without the snapshot directory growing unbounded over a long-lived
# session.
tail -n 500 "$TRANSCRIPT_PATH" > "$SNAPSHOT_FILE" 2>/dev/null || exit 0

DAILY_FILE="$DAILY_DIR/$(date +%F).md"
POINTER="- [auto] Context compacted at $(date +%H:%M); raw snapshot: memory/precompact-snapshots/$(basename "$SNAPSHOT_FILE")"
echo "$POINTER" >> "$DAILY_FILE" 2>/dev/null

exit 0
