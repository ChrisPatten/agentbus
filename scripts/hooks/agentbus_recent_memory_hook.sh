#!/usr/bin/env bash
# AgentBus recent-memory freshness hook (E67, docs/AGENT_MEMORY.md#freshness-hook).
#
# Keeps a long-lived Claude Code session (a cc-pool pane) up to date with the
# agent's bus-generated memory/recent.md. The session loads recent.md through
# its CLAUDE.md import when it starts; when a journal run or the midnight
# rollover changes the file later, this hook adds the new version to the next
# prompt's context.
#
# Register it in the agent's project .claude/settings.json (a symlink back to
# this file is the recommended setup) for:
#
#   UserPromptSubmit  -> prints recent.md when it changed since this session saw it
#   SessionStart      -> (recommended) records what the session just loaded, so
#                        the first prompt after a launch, /compact or /clear
#                        doesn't repeat it
#
# One script serves every agent: the bus resolves the agent from the Claude
# session id, so there is nothing per-deployment to edit.
#
# Environment (all optional; the same convention as the other AgentBus hooks):
#   AGENTBUS_URL         bus base URL (default http://127.0.0.1:3000)
#   AGENTBUS_BUS_TOKEN   sent as X-Bus-Token when bus.auth_token is set (cc-pool
#                        exports it into every pane)
#   AGENTBUS_TOKEN       older name for the same, used when AGENTBUS_BUS_TOKEN is unset
#   AGENTBUS_TOKEN_FILE  file holding the token, used when neither is set
#   AGENTBUS_AGENT_ID    fallback agent id when the session id isn't known to the
#                        bus (for example a plain claude-code session)
#
# Requires jq and curl. Best-effort throughout: on any failure it prints
# nothing, always exits 0, and gives up after 2 seconds.

set -uo pipefail

AGENTBUS_URL="${AGENTBUS_URL:-http://127.0.0.1:3000}"

TOKEN="${AGENTBUS_BUS_TOKEN:-${AGENTBUS_TOKEN:-}}"
if [[ -z "$TOKEN" && -n "${AGENTBUS_TOKEN_FILE:-}" && -r "${AGENTBUS_TOKEN_FILE}" ]]; then
  TOKEN="$(head -n 1 "$AGENTBUS_TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
fi

command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
HOOK_EVENT="$(jq -r '.hook_event_name // empty' <<<"$INPUT" 2>/dev/null)"
SESSION_ID="$(jq -r '.session_id // empty' <<<"$INPUT" 2>/dev/null)"

[[ -n "$SESSION_ID" ]] || exit 0

case "$HOOK_EVENT" in
  UserPromptSubmit) EVENT="prompt" ;;
  SessionStart) EVENT="session-start" ;;
  *) exit 0 ;;
esac

QUERY="$(jq -rn --arg sid "$SESSION_ID" --arg ev "$EVENT" --arg agent "${AGENTBUS_AGENT_ID:-}" \
  '"harness_session_id=\($sid | @uri)&event=\($ev)" + (if $agent != "" then "&agent=\($agent | @uri)" else "" end)')"
URL="$AGENTBUS_URL/api/v1/memory/recent?$QUERY"

# The token goes to curl on stdin (-K -) so it never shows up in the process
# list. With no token, the request carries no auth header.
bus_get() {
  if [[ -n "$TOKEN" ]]; then
    local t="${TOKEN//\\/\\\\}"
    t="${t//\"/\\\"}"
    printf 'header = "X-Bus-Token: %s"\n' "$t" | curl -sf --max-time 2 -K - "$URL"
  else
    curl -sf --max-time 2 "$URL" </dev/null
  fi
}

RESPONSE="$(bus_get 2>/dev/null)" || exit 0
[[ "$EVENT" == "prompt" ]] || exit 0
if [[ "$(jq -r '.changed // false' <<<"$RESPONSE" 2>/dev/null)" == "true" ]]; then
  # UserPromptSubmit: stdout is added to the prompt's context.
  jq -r '.context // empty' <<<"$RESPONSE" 2>/dev/null
fi

exit 0
