#!/usr/bin/env bash
# AgentBus recent-memory hook (E67 freshness, E73 delivery;
# docs/AGENT_MEMORY.md#freshness-hook).
#
# Keeps a Claude Code session up to date with the agent's bus-generated
# memory/recent.md. One script serves every runtime (cc-headless, cc-pool,
# interactive sessions): the bus decides what to send, this script relays it.
#
# Register it in the agent project's .claude/settings.json for BOTH events:
#
#   SessionStart      -> source startup|resume|clear|compact|fork
#   UserPromptSubmit
#
# Recommended command (the env prefix needs no wrapper; use an absolute path):
#
#   AGENTBUS_AGENT_ID=<agent> AGENTBUS_RECENT_FILE=<abs path to memory/recent.md> /path/to/agentbus_recent_memory_hook.sh
#
# The hook calls GET /api/v1/memory/recent with the session id, the event and,
# on SessionStart, the hook input's `source`. The bus checks the agent's
# CLAUDE.md and picks a mode; `.changed` and `.context` in its answer say what
# to print (stdout of both events is added to the session's context):
#
#   hook mode    (CLAUDE.md does NOT import recent.md): the hook is the only way
#                the session gets the file. SessionStart prints the whole file
#                for a new session id (startup, clear and fork arrive with one)
#                and after compaction; later SessionStart (resume) and
#                UserPromptSubmit calls print only entries added since.
#   import mode  (CLAUDE.md imports recent.md): Claude Code loads the file
#                itself, so SessionStart prints nothing and the hook only sends
#                new entries.
#
# Disk fallback: when the bus request fails (curl error, timeout, non-2xx or an
# unparsable answer) on a SessionStart whose source is startup, clear, compact
# or fork, and AGENTBUS_RECENT_FILE names a readable file, the hook prints a
# short preamble line plus that file, so the agent never starts without it.
# Never on `resume` (it fires on every headless `-p --resume` turn, so the file
# would be repeated each turn), and never on UserPromptSubmit (silent on failure).
# In import mode the fallback also prints the file (the hook can't know the
# mode when the bus is down), so a deployment that keeps the import should leave
# AGENTBUS_RECENT_FILE unset.
#
# Environment (all optional; the same convention as the other AgentBus hooks):
#   AGENTBUS_URL          bus base URL (default http://127.0.0.1:3000)
#   AGENTBUS_BUS_TOKEN    sent as X-Bus-Token when bus.auth_token is set (cc-pool
#                         exports it into every pane)
#   AGENTBUS_TOKEN        older name for the same, used when AGENTBUS_BUS_TOKEN is unset
#   AGENTBUS_TOKEN_FILE   file holding the token, used when neither is set
#   AGENTBUS_AGENT_ID     agent id for sessions the bus doesn't know (for example a
#                         desktop or plain claude-code session)
#   AGENTBUS_RECENT_FILE  absolute path of the agent's recent.md, for the disk fallback
#
# Requires jq (without it the hook prints nothing: it can't read the hook input)
# and curl (without it the disk fallback still applies). Best-effort throughout:
# always exits 0, and gives up on the bus after 2 seconds.

set -uo pipefail

AGENTBUS_URL="${AGENTBUS_URL:-http://127.0.0.1:3000}"

TOKEN="${AGENTBUS_BUS_TOKEN:-${AGENTBUS_TOKEN:-}}"
if [[ -z "$TOKEN" && -n "${AGENTBUS_TOKEN_FILE:-}" && -r "${AGENTBUS_TOKEN_FILE}" ]]; then
  TOKEN="$(head -n 1 "$AGENTBUS_TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
fi

command -v jq >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
HOOK_EVENT="$(jq -r '.hook_event_name // empty' <<<"$INPUT" 2>/dev/null)"
SESSION_ID="$(jq -r '.session_id // empty' <<<"$INPUT" 2>/dev/null)"
SOURCE=""

[[ -n "$SESSION_ID" ]] || exit 0

case "$HOOK_EVENT" in
  UserPromptSubmit) EVENT="prompt" ;;
  SessionStart)
    EVENT="session-start"
    SOURCE="$(jq -r '.source // empty' <<<"$INPUT" 2>/dev/null)"
    ;;
  *) exit 0 ;;
esac

QUERY="$(jq -rn --arg sid "$SESSION_ID" --arg ev "$EVENT" --arg src "$SOURCE" --arg agent "${AGENTBUS_AGENT_ID:-}" \
  '"harness_session_id=\($sid | @uri)&event=\($ev)" + (if $src != "" then "&source=\($src | @uri)" else "" end) + (if $agent != "" then "&agent=\($agent | @uri)" else "" end)')"
URL="$AGENTBUS_URL/api/v1/memory/recent?$QUERY"

# The token goes to curl on stdin (-K -) so it never shows up in the process
# list. With no token, the request carries no auth header.
bus_get() {
  command -v curl >/dev/null 2>&1 || return 1
  if [[ -n "$TOKEN" ]]; then
    local t="${TOKEN//\\/\\\\}"
    t="${t//\"/\\\"}"
    printf 'header = "X-Bus-Token: %s"\n' "$t" | curl -sf --max-time 2 -K - "$URL"
  else
    curl -sf --max-time 2 "$URL" </dev/null
  fi
}

# The bus request failed: on a session start that has no earlier copy to rely
# on, print recent.md from disk.
disk_fallback() {
  [[ "$EVENT" == "session-start" ]] || return 0
  case "$SOURCE" in startup | clear | compact | fork) ;; *) return 0 ;; esac
  local f="${AGENTBUS_RECENT_FILE:-}"
  [[ -n "$f" && -r "$f" && -s "$f" ]] || return 0
  printf 'AgentBus: the bus was unreachable, so this is %s as last written to disk (your recent daily journals; it may be slightly out of date):\n\n' "$f"
  cat "$f" 2>/dev/null
}

RESPONSE="$(bus_get 2>/dev/null)" || { disk_fallback; exit 0; }
if [[ "$(jq -r '.ok // false' <<<"$RESPONSE" 2>/dev/null)" != "true" ]]; then
  disk_fallback
  exit 0
fi
if [[ "$(jq -r '.changed // false' <<<"$RESPONSE" 2>/dev/null)" == "true" ]]; then
  # SessionStart and UserPromptSubmit: stdout is added to the session's context.
  jq -r '.context // empty' <<<"$RESPONSE" 2>/dev/null
fi

exit 0
