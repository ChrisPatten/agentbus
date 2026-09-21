#!/usr/bin/env bash
# Deployed into a pool agent's own project directory as
# scripts/hooks/agentbus_stop_hook.sh (a symlink back to this file is the
# recommended setup — see docs/CC_POOL_ADAPTER.md#post-apiv1poolagentidturn-ended)
# and wired into that project's .claude/settings.json as a Stop hook. Lives
# in this repo because it's AgentBus functionality, even though it runs
# inside a separate Claude Code project's hook process, not inside bus-core
# itself.
#
# Real-time pane activity signal for AgentBus's cc-pool adapter.
#
# pool-manager's lease store only bumps a pane's last_activity_at when a new
# message is routed IN (acquire()'s reuse branch) — not when the agent
# actually finishes responding. A long turn or thinking time can then look
# idle to idle_evict_ms/hard_idle_ms prematurely. This Stop hook fires after
# every assistant turn and tells AgentBus's HTTP API to touch() the matching
# pane's last_activity_at, so pool idle-eviction timing reflects reality.
#
# Fire-and-forget: never blocks or fails the turn.

set -uo pipefail

AGENTBUS_BASE="http://127.0.0.1:3000"
# The pool's bare agent id is a hardcoded per-deployment constant (one
# deployment == one agent's project dir with its own hook symlink), not
# derived from anything at runtime — a second agent reusing this script
# needs its own copy of the registration with this changed to match.
POOL_AGENT_ID="peggy"

INPUT="$(cat)"
SESSION_ID="$(jq -r '.session_id // empty' <<<"$INPUT")"

[[ -n "$SESSION_ID" ]] || exit 0

BODY="$(jq -nc --arg sid "$SESSION_ID" '{session_id: $sid}')"

( curl -s --max-time 3 -X POST "$AGENTBUS_BASE/api/v1/pool/$POOL_AGENT_ID/turn-ended" \
    -H 'Content-Type: application/json' \
    -d "$BODY" >/dev/null 2>&1 & )

exit 0
