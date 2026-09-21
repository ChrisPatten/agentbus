#!/usr/bin/env bash
# Deployed into a pool agent's own project directory as
# scripts/hooks/agentbus_tool_status_hook.sh (a symlink back to this file is
# the recommended setup — see docs/CC_POOL_ADAPTER.md#live-tool-call-status-stream)
# and wired into that project's .claude/settings.json as both a
# UserPromptSubmit and a PostToolUse hook. Lives in this repo because it's
# AgentBus functionality (E29), even though it runs inside a separate Claude
# Code project's hook process, not inside bus-core itself.
#
# Restores the E29 live tool-call status stream (and the typing indicator)
# for the `claude-code`/MCP adapter model. `cc-headless` gets these for free
# by parsing its spawned `claude -p` process's own stdout stream — an MCP-mode
# session has no equivalent visibility from the bus side, since bus-core only
# ever sees calls to the small set of MCP tools it itself exposes. The fix:
# the REST endpoints behind these features (`/api/v1/adapters/:id/typing` and
# `/tool-status`) are adapter-agnostic, so a Claude Code hook can call them
# directly, using Claude Code's own hook events as the missing signal source.
#
# UserPromptSubmit: parses "New message from <sender> via <channel> ..." out
# of the inbound prompt text (that's literally how AgentBus formats envelopes
# — see CLAUDE.md's Inbound Message Handling section) and caches the
# (channel, contact) pairs found to a per-session state file, then fires the
# typing indicator for each.
#
# PostToolUse: reads that cached state and posts a short status line for the
# tool that just ran, to each cached (channel, contact) pair. Skips the
# delivery tools themselves (reply/send_message) — same as cc-headless's own
# DELIVERY_TOOL_NAMES exclusion — since the draft message they'd be
# annotating is about to be overwritten with the real reply anyway. Skips
# email channels entirely, matching cc-headless's reportToolCall.
#
# Suppresses everything AFTER delivery too (fixed Sep 15, 2026 — Chris
# reported post-reply tool activity, e.g. memory writes done after replying,
# was showing up as live status noise, which cc-headless never did). A
# `reply`/`send_message` call sets a per-session "delivered" sentinel; every
# PostToolUse after that is suppressed until the next UserPromptSubmit
# resets it. cc-headless has no equivalent gap in the first place — E30
# means it isn't supposed to do real work after replying at all — so this
# hook has to recreate the boundary by hand.
#
# Best-effort throughout: never blocks or fails the actual tool call. A
# missing state file (e.g. a tool ran outside of any inbound-message turn,
# like an autonomous background sweep) is not an error — the hook just
# has nothing to report to and exits quietly.

set -uo pipefail

AGENTBUS_BASE="http://127.0.0.1:3000"
# STATE_DIR is per-agent by convention (one deployment == one agent's project
# dir with its own hook symlink), not derived from anything at runtime — a
# second agent reusing this script needs its own STATE_DIR value here.
STATE_DIR="/tmp/peggy-agentbus-hook-state"
mkdir -p "$STATE_DIR"

INPUT="$(cat)"
EVENT="$(jq -r '.hook_event_name // empty' <<<"$INPUT")"
SESSION_ID="$(jq -r '.session_id // "unknown"' <<<"$INPUT")"
STATE_FILE="$STATE_DIR/route-${SESSION_ID}.json"
DELIVERED_FLAG="$STATE_DIR/delivered-${SESSION_ID}"

# channel names this repo actually routes email through — kept in sync with
# cc-headless's own `channel === 'email' || channel.startsWith('email:')` skip.
is_email_channel() {
  [[ "$1" == email || "$1" == email:* ]]
}

post_async() {
  # Fire-and-forget: never let a slow/unreachable bus-core add latency to
  # the turn. Backgrounded + short --max-time as a second layer of safety.
  local url="$1" body="$2"
  ( curl -s --max-time 3 -X POST "$url" -H 'Content-Type: application/json' -d "$body" >/dev/null 2>&1 & )
}

case "$EVENT" in
  UserPromptSubmit)
    PROMPT="$(jq -r '.prompt // empty' <<<"$INPUT")"
    [[ -n "$PROMPT" ]] || exit 0

    # Extract every "New message from <sender> via <channel> (topic: <topic>)"
    # triple — a batch turn can carry more than one. Sender/channel/topic
    # tokens are the bus's own identifiers (e.g. "contact:chris",
    # "telegram:peggy", "thread:9cfaf60aed4358c6"): colons, dots, dashes,
    # underscores, alnum. `topic` was added to the formatted line by AgentBus
    # (src/adapters/cc.ts's formatMessagesForSampling, E48-era fix) so this
    # hook can target the actual Telegram forum topic a message came in on
    # instead of always falling back to the group's general area — dedup key
    # includes topic too, so two different topics from the same sender/channel
    # in one batch both get their own typing indicator instead of collapsing
    # into one.
    #
    # The "(topic: ...)" segment is matched as OPTIONAL (not required). A
    # pool pane's cc.ts subprocess is spawned once, at pane launch, and reads
    # whatever agentbus source existed at that moment — it never restarts on
    # its own. A pane launched before the topic segment shipped keeps
    # formatting messages the old way (no "(topic: ...)") for as long as it
    # stays alive, which for a pooled long-lived pane can be days. Requiring
    # the segment meant this hook produced zero matches — and therefore no
    # tool-status updates at all — against every still-running pre-fix pane
    # (discovered 2026-09-20: 4 of 5 live pool panes predated the topic
    # commit and had gone completely silent). Falling back to "general" when
    # the segment is absent matches the pre-fix behavior exactly and keeps
    # this hook working across that version skew without requiring every
    # pool pane to be restarted in lockstep with agentbus deploys.
    PAIRS_JSON="$(python3 -c '
import json, re, sys
prompt = sys.stdin.read()
pairs = re.findall(r"New message from (\S+) via (\S+)(?: \(topic: (\S+)\))?", prompt)
seen = set()
out = []
for sender, channel, topic in pairs:
    topic = topic or "general"
    key = (sender, channel, topic)
    if key in seen:
        continue
    seen.add(key)
    out.append({"contact_id": sender, "channel": channel, "topic": topic})
print(json.dumps(out))
' <<<"$PROMPT")"

    echo "$PAIRS_JSON" > "$STATE_FILE"
    rm -f "$DELIVERED_FLAG"

    echo "$PAIRS_JSON" | jq -c '.[]' | while read -r pair; do
      channel="$(jq -r '.channel' <<<"$pair")"
      contact_id="$(jq -r '.contact_id' <<<"$pair")"
      topic="$(jq -r '.topic' <<<"$pair")"
      is_email_channel "$channel" && continue
      body="$(jq -nc --arg cid "$contact_id" --arg topic "$topic" '{contact_id: $cid, topic: $topic}')"
      post_async "$AGENTBUS_BASE/api/v1/adapters/$channel/typing" "$body"
    done
    ;;

  PostToolUse)
    [[ -f "$STATE_FILE" ]] || exit 0

    TOOL_NAME="$(jq -r '.tool_name // "tool"' <<<"$INPUT")"
    case "$TOOL_NAME" in
      mcp__agentbus__reply|mcp__agentbus__send_message)
        touch "$DELIVERED_FLAG"
        exit 0
        ;;
    esac

    # Already delivered this turn — everything from here on is post-reply
    # work (memory writes, follow-up cleanup, etc.) that should stay silent.
    [[ -f "$DELIVERED_FLAG" ]] && exit 0

    TOOL_INPUT_JSON="$(jq -c '.tool_input // {}' <<<"$INPUT")"

    STATUS_TEXT="$(python3 -c '
import json, sys
name = sys.argv[1]
try:
    inp = json.loads(sys.argv[2])
except Exception:
    inp = {}

def trunc(s, n=80):
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"

short = name.split("__")[-1] if "__" in name else name
command = inp.get("command", "")
file_path = inp.get("file_path", "")
url = inp.get("url", "")
query = inp.get("query", "")
pattern = inp.get("pattern", "")
description = inp.get("description", short)

if name == "Bash":
    text = "Running: " + trunc(command)
elif name == "Read":
    text = "Reading " + trunc(file_path, 60)
elif name in ("Edit", "Write", "NotebookEdit"):
    text = "Editing " + trunc(file_path, 60)
elif name == "WebFetch":
    text = "Fetching " + trunc(url, 60)
elif name == "WebSearch":
    text = "Searching: " + trunc(query, 60)
elif name in ("Grep", "Glob"):
    text = "Searching files: " + trunc(pattern, 60)
elif name == "Agent":
    text = "Delegating: " + trunc(description, 60)
elif name.startswith("mcp__agentbus__"):
    text = "AgentBus: " + short
elif name.startswith("mcp__"):
    text = "Using " + short
else:
    text = "Using " + name

print(trunc(text, 200))
' "$TOOL_NAME" "$TOOL_INPUT_JSON")"

    jq -c '.[]' "$STATE_FILE" | while read -r pair; do
      channel="$(jq -r '.channel' <<<"$pair")"
      contact_id="$(jq -r '.contact_id' <<<"$pair")"
      topic="$(jq -r '.topic // "general"' <<<"$pair")"
      is_email_channel "$channel" && continue
      body="$(jq -nc --arg cid "$contact_id" --arg text "$STATUS_TEXT" --arg topic "$topic" '{contact_id: $cid, text: $text, topic: $topic}')"
      post_async "$AGENTBUS_BASE/api/v1/adapters/$channel/tool-status" "$body"
    done
    ;;
esac

exit 0
