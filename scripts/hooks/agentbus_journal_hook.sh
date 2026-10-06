#!/usr/bin/env bash
# Generic AgentBus journal hook (E66, docs/JOURNALING.md#hooks).
#
# Install it in an agent's project .claude/settings.json for the Claude Code
# hook events below (a symlink back to this file is the recommended setup).
# One script serves every agent: the bus resolves the agent and conversation
# from the Claude session id, so there is nothing per-deployment to edit.
#
#   Stop        -> turn-ended   re-anchors the bus's pause timer (never journals)
#   PreCompact  -> pre-compact  snapshot the transcript, then ask the bus to journal
#   SessionEnd  -> session-end  (reason "clear" -> clear): snapshot, then journal
#
# "Preserve now, journal later": before context is compacted or cleared, the
# hook copies the raw transcript to a snapshot file and registers its path,
# and the next journal run reads it.
#
# Environment (all optional):
#   AGENTBUS_URL            bus base URL (default http://127.0.0.1:3000)
#   AGENTBUS_TOKEN          sent as X-Bus-Token when bus.auth_token is set
#   AGENTBUS_TOKEN_FILE     file holding the token, used when AGENTBUS_TOKEN is unset
#   AGENTBUS_SNAPSHOT_DIR   where snapshots go (default ~/.agentbus/journal-snapshots).
#                           The bus only accepts snapshots under that default
#                           directory or the agent's working directory.
#   AGENTBUS_SNAPSHOT_LINES lines kept per snapshot (default 2000)
#
# Requires jq and curl. Best-effort throughout: it prints nothing, always
# exits 0, and never blocks the turn, compaction or /clear.

set -uo pipefail

AGENTBUS_URL="${AGENTBUS_URL:-http://127.0.0.1:3000}"
SNAPSHOT_DIR="${AGENTBUS_SNAPSHOT_DIR:-$HOME/.agentbus/journal-snapshots}"
SNAPSHOT_LINES="${AGENTBUS_SNAPSHOT_LINES:-2000}"

TOKEN="${AGENTBUS_TOKEN:-}"
if [[ -z "$TOKEN" && -n "${AGENTBUS_TOKEN_FILE:-}" && -r "${AGENTBUS_TOKEN_FILE}" ]]; then
  TOKEN="$(head -n 1 "$AGENTBUS_TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
fi

command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
HOOK_EVENT="$(jq -r '.hook_event_name // empty' <<<"$INPUT" 2>/dev/null)"
SESSION_ID="$(jq -r '.session_id // empty' <<<"$INPUT" 2>/dev/null)"
TRANSCRIPT_PATH="$(jq -r '.transcript_path // empty' <<<"$INPUT" 2>/dev/null)"
REASON="$(jq -r '.reason // empty' <<<"$INPUT" 2>/dev/null)"

[[ -n "$SESSION_ID" ]] || exit 0

case "$HOOK_EVENT" in
  Stop) EVENT="turn-ended" ;;
  PreCompact) EVENT="pre-compact" ;;
  SessionEnd) if [[ "$REASON" == "clear" ]]; then EVENT="clear"; else EVENT="session-end"; fi ;;
  *) exit 0 ;;
esac

SNAPSHOT=""
if [[ "$EVENT" != "turn-ended" && -n "$TRANSCRIPT_PATH" && -f "$TRANSCRIPT_PATH" ]]; then
  if mkdir -p "$SNAPSHOT_DIR" 2>/dev/null; then
    SAFE_ID="$(tr -cd 'A-Za-z0-9_-' <<<"$SESSION_ID")"
    CANDIDATE="$SNAPSHOT_DIR/${SAFE_ID}-${EVENT}-$(date +%s).jsonl"
    if tail -n "$SNAPSHOT_LINES" "$TRANSCRIPT_PATH" > "$CANDIDATE" 2>/dev/null; then
      SNAPSHOT="$CANDIDATE"
    fi
  fi
fi

BODY="$(jq -nc \
  --arg sid "$SESSION_ID" \
  --arg event "$EVENT" \
  --arg snap "$SNAPSHOT" \
  --arg tp "$TRANSCRIPT_PATH" \
  '{harness_session_id: $sid, event: $event}
   + (if $snap != "" then {snapshot_path: $snap} else {} end)
   + (if $tp != "" then {transcript_path: $tp} else {} end)')"

HEADERS=(-H 'Content-Type: application/json')
[[ -n "$TOKEN" ]] && HEADERS+=(-H "X-Bus-Token: $TOKEN")

# Snapshot events wait briefly so the registration lands before the context
# is gone; turn-ended is fire-and-forget.
if [[ "$EVENT" == "turn-ended" ]]; then
  ( curl -s --max-time 3 -X POST "$AGENTBUS_URL/api/v1/journal/events" "${HEADERS[@]}" -d "$BODY" >/dev/null 2>&1 & )
else
  curl -s --max-time 5 -X POST "$AGENTBUS_URL/api/v1/journal/events" "${HEADERS[@]}" -d "$BODY" >/dev/null 2>&1
fi

exit 0
