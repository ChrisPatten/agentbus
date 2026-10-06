#!/usr/bin/env bash
# Deployed into a pool agent's own project directory as
# scripts/hooks/agentbus_approval_hook.sh (a symlink back to this file is the
# recommended setup, same as agentbus_tool_status_hook.sh) and wired into that
# project's .claude/settings.json as a PermissionRequest hook. Lives in this
# repo because it's AgentBus functionality (E51, docs/APPROVALS.md), even
# though it runs inside a separate Claude Code project's hook process.
#
# Claude Code fires PermissionRequest the moment an interactive permission
# dialog is about to block the pane. This hook reports it to bus-core, which
# asks the addressed human (Telegram Approve/Deny buttons) and answers the
# dialog by sending Enter/Escape into the pane. The hook itself NEVER decides:
# it prints nothing and exits 0, so the dialog appears and behaves exactly as
# it would with no hook installed — a human at the terminal can still answer
# it first.
#
# The pane is identified by Claude session id, not $AGENTBUS_AGENT_ID: only
# the pane's MCP server has that variable, not the shell Claude Code runs
# hooks in. bus-core maps session id -> pane from the lease table, the same
# way /turn-ended does.
#
# Best-effort throughout: a failed POST must never affect the dialog.

set -uo pipefail

AGENTBUS_BASE="http://127.0.0.1:3000"

# bus.auth_token support: when AGENTBUS_BUS_TOKEN is set (cc-pool exports it
# into every pane window it creates; otherwise export it yourself in the
# shell that starts claude), every POST carries X-Bus-Token. The header goes
# to curl on stdin (-K -) so the token never shows up in the process list.
# With no token set, the request is exactly what it was before.
bus_post() {
  local url="$1" body="$2"
  if [[ -n "${AGENTBUS_BUS_TOKEN:-}" ]]; then
    local t="${AGENTBUS_BUS_TOKEN//\\/\\\\}"
    t="${t//\"/\\\"}"
    printf 'header = "X-Bus-Token: %s"\n' "$t" \
      | curl -s --max-time 3 -K - -X POST "$url" -H 'Content-Type: application/json' -d "$body"
  else
    curl -s --max-time 3 -X POST "$url" -H 'Content-Type: application/json' -d "$body" </dev/null
  fi
}

INPUT="$(cat)"
SESSION_ID="$(jq -r '.session_id // empty' <<<"$INPUT")"
TOOL_NAME="$(jq -r '.tool_name // empty' <<<"$INPUT")"

[[ -n "$SESSION_ID" && -n "$TOOL_NAME" ]] || exit 0

# One-line, human-readable description of what is being asked.
DETAIL="$(jq -r '
  .tool_input as $i
  | if   ($i.command // null) != null   then $i.command
    elif ($i.file_path // null) != null then $i.file_path
    elif ($i.notebook_path // null) != null then $i.notebook_path
    elif ($i.url // null) != null       then $i.url
    else ($i | tostring) end
  | gsub("\\s+"; " ")
  | .[0:300]' <<<"$INPUT")"

BODY="$(jq -nc \
  --arg sid "$SESSION_ID" \
  --arg tool "$TOOL_NAME" \
  --arg summary "${DETAIL:-$TOOL_NAME}" \
  --argjson ctx "$(jq -c '{cwd: .cwd, tool_input: .tool_input}' <<<"$INPUT")" \
  '{adapterId: "cc-pool", sessionId: $sid, toolName: $tool, summary: $summary, context: $ctx}')"

( bus_post "$AGENTBUS_BASE/api/v1/approvals" "$BODY" >/dev/null 2>&1 & )

exit 0
