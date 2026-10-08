#!/usr/bin/env bash
# Deployed into a pool agent's own project directory as
# scripts/hooks/agentbus_stop_hook.sh (a symlink back to this file is the
# recommended setup — see docs/CC_POOL_ADAPTER.md#post-apiv1poolagentidturn-ended)
# and wired into that project's .claude/settings.json as a Stop hook.
#
# Real-time pane activity signal for AgentBus's cc-pool adapter. pool-manager's
# lease store only bumps a pane's last_activity_at when a message is routed
# IN, not when the agent finishes responding, so a long turn could look idle
# to idle_evict_ms/hard_idle_ms. This Stop hook fires after every assistant
# turn and reports it to the bus.
#
# E66: posts `turn-ended` to the generic POST /api/v1/journal/events, which
# resolves the pane from the Claude session id (no hardcoded agent id),
# marks the pane's turn ended and re-anchors the journaling pause timer.
# New installs can use scripts/hooks/agentbus_journal_hook.sh for Stop,
# PreCompact and SessionEnd instead; it does the same for Stop.
#
# Fire-and-forget: never blocks or fails the turn.

set -uo pipefail

AGENTBUS_URL="${AGENTBUS_URL:-http://127.0.0.1:3000}"
# bus.auth_token: AGENTBUS_BUS_TOKEN (cc-pool exports it into every pane),
# else the older AGENTBUS_TOKEN, else AGENTBUS_TOKEN_FILE.
TOKEN="${AGENTBUS_BUS_TOKEN:-${AGENTBUS_TOKEN:-}}"
if [[ -z "$TOKEN" && -n "${AGENTBUS_TOKEN_FILE:-}" && -r "${AGENTBUS_TOKEN_FILE}" ]]; then
  TOKEN="$(head -n 1 "$AGENTBUS_TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
fi

INPUT="$(cat)"
SESSION_ID="$(jq -r '.session_id // empty' <<<"$INPUT")"

[[ -n "$SESSION_ID" ]] || exit 0

BODY="$(jq -nc --arg sid "$SESSION_ID" '{harness_session_id: $sid, event: "turn-ended"}')"

# The token goes to curl on stdin (-K -) so it never shows in the process list.
bus_post() {
  if [[ -n "$TOKEN" ]]; then
    local t="${TOKEN//\\/\\\\}"
    t="${t//\"/\\\"}"
    printf 'header = "X-Bus-Token: %s"\n' "$t" \
      | curl -s --max-time 3 -K - -X POST "$AGENTBUS_URL/api/v1/journal/events" -H 'Content-Type: application/json' -d "$BODY"
  else
    curl -s --max-time 3 -X POST "$AGENTBUS_URL/api/v1/journal/events" -H 'Content-Type: application/json' -d "$BODY" </dev/null
  fi
}

( bus_post >/dev/null 2>&1 & )

exit 0
