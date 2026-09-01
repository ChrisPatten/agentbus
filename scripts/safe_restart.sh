#!/bin/bash
#
# safe_restart.sh — Restart bus-core, verify it actually comes up healthy,
# and automatically roll back to `main` if it doesn't. Never leaves bus-core
# silently broken:
#
#   1. Restart bus-core (pm2) on the current branch/commit. Immediately
#      before each restart attempt, while bus-core is still confirmed
#      healthy, create a durable one-shot wake-up schedule (E40) targeting
#      the channel/topic that triggered the restart, with a 45-minute
#      staleness ceiling — this survives even if this script (or the Bash
#      tool call running it) dies immediately after kicking off the restart.
#   2. Poll GET /api/v1/health for up to HEALTH_TIMEOUT_S seconds.
#   3a. Healthy -> notify Peggy via AgentBus's own inbound endpoint
#       (system channel, or --notify-channel/--notify-topic if given) that
#       the restart succeeded. Belt-and-suspenders alongside the scheduled
#       wake-up from step 1 during the E40 transition — see docs/SCHEDULING.md.
#   3b. Unhealthy -> stash any uncommitted changes (never discard work),
#       checkout `main` (the last released/stable branch), npm ci if the
#       lockfile changed, restart again, poll again.
#   4a. Healthy after rollback -> notify Peggy (mentions the rollback so it
#       gets surfaced to Chris, and that the broken commit(s) are still
#       sitting untouched on the original branch for later investigation).
#   4b. STILL unhealthy after rollback -> email Chris directly via SMTP
#       (send_direct_email.py), bypassing AgentBus entirely, since bus-core
#       being down means its own send_email path is unusable too.
#
# Usage: scripts/safe_restart.sh [--notify-channel <channel>] [--notify-topic <topic>]
#   Both optional. If omitted, falls back to the generic system/safe-restart
#   channel/topic (today's behavior).
# Logs to logs/safe_restart/<timestamp>.log (also tees to stdout).

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
REPO_ROOT="$(pwd)"
LOG_DIR="$REPO_ROOT/logs/safe_restart"
mkdir -p "$LOG_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/${TS}.log"

HEALTH_URL="http://127.0.0.1:3000/api/v1/health"
AGENTBUS_INBOUND_URL="http://127.0.0.1:3000/api/v1/inbound"
AGENTBUS_SCHEDULES_URL="http://127.0.0.1:3000/api/v1/schedules"
HEALTH_TIMEOUT_S=30
HEALTH_POLL_INTERVAL_S=2
WAKEUP_STALE_AFTER_MS=$(( 45 * 60 * 1000 ))
CHRIS_EMAIL="chris@chrispatten.dev"
PM2="$REPO_ROOT/node_modules/.bin/pm2"

NOTIFY_CHANNEL=""
NOTIFY_TOPIC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notify-channel)
      NOTIFY_CHANNEL="${2:-}"
      shift 2
      ;;
    --notify-topic)
      NOTIFY_TOPIC="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

pm2_bus_core_status() {
  "$PM2" jlist 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for p in data:
        if p.get('name') == 'bus-core':
            print(p['pm2_env'].get('status', 'unknown'))
            sys.exit(0)
except Exception:
    pass
print('unknown')
"
}

# Polls health for up to HEALTH_TIMEOUT_S seconds. Returns 0 if both the HTTP
# health endpoint reports ok AND pm2 itself reports the process as "online"
# (catches the case where the endpoint briefly responds during a crash loop
# but pm2 is still restarting it repeatedly).
check_health() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local resp
    resp="$(curl -sf --max-time 3 "$HEALTH_URL" 2>/dev/null)"
    if [ -n "$resp" ] && echo "$resp" | /usr/bin/grep -q '"ok":true'; then
      if [ "$(pm2_bus_core_status)" = "online" ]; then
        return 0
      fi
    fi
    sleep "$HEALTH_POLL_INTERVAL_S"
  done
  return 1
}

restart_bus_core() {
  log "Restarting bus-core via pm2 (startOrRestart)..."
  ( AGENTBUS_CONFIG=config.yaml "$PM2" startOrRestart ecosystem.config.cjs ) >>"$LOG_FILE" 2>&1
}

# One-shot reachability check (not a poll) — used to decide whether it's even
# worth trying to create a wake-up schedule before a restart attempt.
is_bus_core_reachable() {
  local resp
  resp="$(curl -sf --max-time 3 "$HEALTH_URL" 2>/dev/null)"
  [ -n "$resp" ] && echo "$resp" | /usr/bin/grep -q '"ok":true'
}

# Creates a durable one-shot wake-up schedule (E40) targeting the resolved
# notify channel/topic, fire_at = now + 10s, stale_after_ms = 45 minutes.
# This is the fallback that survives even if this script (or the tool call
# running it) is killed immediately after triggering the restart — see
# docs/SCHEDULING.md's "Worked example: durable post-restart wake-up".
# No-op (logged) if bus-core isn't reachable right now — nothing to POST to.
create_wakeup_schedule() {
  local context="$1"
  if ! is_bus_core_reachable; then
    log "bus-core not reachable right now - skipping durable wake-up schedule ($context)."
    return
  fi

  local payload
  payload="$(python3 - "$NOTIFY_CHANNEL" "$NOTIFY_TOPIC" "$context" "$WAKEUP_STALE_AFTER_MS" <<'PYEOF'
import json, sys
from datetime import datetime, timedelta, timezone

channel, topic, context, stale_after_ms = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
fire_at = (datetime.now(timezone.utc) + timedelta(seconds=10)).strftime('%Y-%m-%dT%H:%M:%SZ')
body = (
    f"Restarting bus-core to pick up a config/code change ({context}). "
    "I'll follow up here once it's back."
)
print(json.dumps({
    "type": "once",
    "fire_at": fire_at,
    "channel": channel,
    "topic": topic,
    "sender": "contact:chris",
    "payload_body": body,
    "stale_after_ms": stale_after_ms,
}))
PYEOF
)"

  local resp
  resp="$(curl -s -X POST "$AGENTBUS_SCHEDULES_URL" -H 'Content-Type: application/json' -d "$payload" 2>>"$LOG_FILE")"
  local sched_id
  sched_id="$(echo "$resp" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('id') or '')
except Exception:
    print('')
" 2>/dev/null)"

  if [ -n "$sched_id" ]; then
    log "Created durable wake-up schedule $sched_id (channel=$NOTIFY_CHANNEL topic=$NOTIFY_TOPIC, $context)."
  else
    log "WARNING: failed to create durable wake-up schedule ($context). Response: $resp"
  fi
}

notify_peggy() {
  local body="$1"
  local payload
  payload="$(python3 - "$body" <<'PYEOF'
import json, sys
body = sys.argv[1]
print(json.dumps({
    "channel": "system",
    "sender": "safe-restart",
    "payload": {"type": "text", "body": body},
}))
PYEOF
)"
  curl -s -X POST "$AGENTBUS_INBOUND_URL" -H 'Content-Type: application/json' -d "$payload" >>"$LOG_FILE" 2>&1
}

email_chris_direct() {
  local subject="$1"
  local body="$2"
  local pw
  pw="$(/usr/bin/grep '^ICLOUD_APP_PW_PEGGY=' "$REPO_ROOT/.env" | cut -d= -f2-)"
  if [ -z "$pw" ]; then
    log "ERROR: could not read ICLOUD_APP_PW_PEGGY from .env - cannot send fallback email."
    return 1
  fi
  python3 "$REPO_ROOT/scripts/send_direct_email.py" \
    --from "Peggy <peggy.pattenbot@icloud.com>" \
    --to "$CHRIS_EMAIL" \
    --subject "$subject" \
    --body "$body" \
    --password "$pw" >>"$LOG_FILE" 2>&1
}

log "=== safe_restart.sh starting ==="

if [ -z "$NOTIFY_CHANNEL" ] || [ -z "$NOTIFY_TOPIC" ]; then
  log "No --notify-channel/--notify-topic provided - falling back to generic system/safe-restart for the durable wake-up schedule."
  NOTIFY_CHANNEL="${NOTIFY_CHANNEL:-system}"
  NOTIFY_TOPIC="${NOTIFY_TOPIC:-safe-restart}"
fi

BEFORE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEFORE_COMMIT="$(git rev-parse --short HEAD)"
log "Current branch: $BEFORE_BRANCH @ $BEFORE_COMMIT"

create_wakeup_schedule "first restart attempt, $BEFORE_BRANCH@$BEFORE_COMMIT"
restart_bus_core

log "Checking health (timeout ${HEALTH_TIMEOUT_S}s)..."
if check_health; then
  log "Healthy. bus-core is back online at $BEFORE_BRANCH@$BEFORE_COMMIT."
  notify_peggy "[safe-restart] bus-core restarted successfully and is healthy (branch $BEFORE_BRANCH @ $BEFORE_COMMIT)."
  log "=== done (success) ==="
  exit 0
fi

log "UNHEALTHY after restart. Capturing pm2 logs, then attempting rollback to main..."
"$PM2" logs bus-core --lines 80 --nostream >>"$LOG_FILE" 2>&1 || true

# Never discard uncommitted work — stash it first (git safety protocol).
if [ -n "$(git status --porcelain)" ]; then
  log "Uncommitted changes present - stashing before rollback (stash message includes timestamp for recovery)."
  git stash push -u -m "safe_restart auto-stash $TS" >>"$LOG_FILE" 2>&1
fi

git fetch origin main >>"$LOG_FILE" 2>&1 || true
git checkout main >>"$LOG_FILE" 2>&1
ROLLBACK_COMMIT="$(git rev-parse --short HEAD)"
log "Checked out main @ $ROLLBACK_COMMIT"

if ! git diff --quiet "$BEFORE_COMMIT" "$ROLLBACK_COMMIT" -- package-lock.json 2>/dev/null; then
  log "package-lock.json differs between $BEFORE_COMMIT and $ROLLBACK_COMMIT - running npm ci"
  npm ci >>"$LOG_FILE" 2>&1
fi

create_wakeup_schedule "post-rollback restart attempt, main@$ROLLBACK_COMMIT"

restart_bus_core

log "Checking health again after rollback (timeout ${HEALTH_TIMEOUT_S}s)..."
if check_health; then
  log "Healthy after rollback to main."
  notify_peggy "[safe-restart] bus-core failed to come up on $BEFORE_BRANCH@$BEFORE_COMMIT and was automatically rolled back to main@$ROLLBACK_COMMIT, where it is now healthy. The broken commit(s) are still on $BEFORE_BRANCH untouched (any uncommitted changes were stashed, not lost) — needs investigation before retrying."
  log "=== done (rolled back, recovered) ==="
  exit 0
fi

log "STILL UNHEALTHY after rollback to main. Emailing Chris directly (bypassing AgentBus, which is down)."
"$PM2" logs bus-core --lines 80 --nostream >>"$LOG_FILE" 2>&1 || true

EMAIL_BODY="bus-core failed to restart on ${BEFORE_BRANCH}@${BEFORE_COMMIT}, and it also failed to come back up after an automatic rollback to main@${ROLLBACK_COMMIT}.

This means AgentBus itself is down right now — Peggy cannot receive or send messages through the normal Telegram/bus path, which is why this is arriving as a direct email instead of the usual channel.

Log file: ${LOG_FILE}

Please check pm2 logs / the log file above when you're able. bus-core is currently sitting on the main branch, not ${BEFORE_BRANCH} — the broken work is preserved there untouched."

if email_chris_direct "AgentBus bus-core is DOWN — manual intervention needed" "$EMAIL_BODY"; then
  log "Fallback email sent to $CHRIS_EMAIL."
else
  log "ERROR: fallback email FAILED to send. This is the worst case — bus-core is down and Chris has not been notified by any channel."
fi

log "=== done (failed to recover, see above) ==="
exit 1
