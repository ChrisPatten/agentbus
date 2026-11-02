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
#       checkout `main` (the last released/stable branch) WITHOUT npm install
#       (it would mutate the shared node_modules), restart again, poll again.
#   4a. Healthy after rollback -> notify Peggy (mentions the rollback so it
#       gets surfaced to Chris, and that the broken commit(s) are still
#       sitting untouched on the original branch for later investigation).
#   4b. STILL unhealthy after rollback -> email Chris directly via SMTP
#       (send_direct_email.py), bypassing AgentBus entirely, since bus-core
#       being down means its own send_email path is unusable too.
#
# Usage: scripts/safe_restart.sh [--dry-run] [--notify-channel <channel>] [--notify-topic <topic>]
#   Channel/topic optional. If omitted, falls back to the generic
#   system/safe-restart channel/topic (today's behavior).
#   --dry-run: runs in the foreground, resolves pm2, polls health for one
#   HEALTH_TIMEOUT_S window and prints what it would do. Restarts nothing,
#   creates no schedules, sends no notifications, touches no git state.
# Environment:
#   PM2_BIN           pm2 binary to use (overrides auto-resolution)
#   HEALTH_TIMEOUT_S  seconds to wait for health (default 90)
# Logs to logs/safe_restart/<timestamp>.log (also tees to stdout).

set -uo pipefail

# Process-tree-kill note: bus-core spawns each Claude Code agent session as a
# child process (see ecosystem.config.cjs — "Only agent connectors ... run as
# separate processes, spawned by their respective runtimes"), so a Bash tool
# call running this script is a *descendant* of bus-core. pm2 restarts kill
# the whole process tree of the process they manage by default (walking
# parent-child PID relationships), which would kill this script itself the
# instant restart_bus_core() tears down the old bus-core process — before
# the health-check/rollback/notify logic below ever gets to run, and before
# the durable wake-up schedule created just above it can even be trusted to
# be the only thing that survives. To avoid that, re-exec ourselves into a
# new session before doing anything else and let the original invocation
# exit immediately: once the parent that forked us exits, the OS reparents
# us to launchd (pid 1), breaking the parent-chain that a tree-kill walk
# would otherwise follow down from bus-core. (Not `setsid` — that binary
# isn't shipped on macOS; `python3 os.setsid()` does the same thing and
# python3 is already a dependency of this script for JSON handling.) Do
# this exactly once (guarded by SAFE_RESTART_DETACHED) — everything below
# this block runs unchanged in the detached copy, logging to the same
# LOG_FILE as before; only the original foreground invocation's own stdout
# mirroring is lost, since it now exits immediately after handing off.
DRY_RUN=0
for _a in "$@"; do [ "$_a" = "--dry-run" ] && DRY_RUN=1; done

if [ "$DRY_RUN" = "0" ] && [ -z "${SAFE_RESTART_DETACHED:-}" ]; then
  export SAFE_RESTART_DETACHED=1
  python3 -c '
import os, sys
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])
' "$0" "$@" </dev/null >/dev/null 2>&1 &
  disown
  exit 0
fi

cd "$(dirname "$0")/.." || exit 1
REPO_ROOT="$(pwd)"
LOG_DIR="$REPO_ROOT/logs/safe_restart"
mkdir -p "$LOG_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/${TS}.log"

HEALTH_URL="http://127.0.0.1:3000/api/v1/health"
AGENTBUS_INBOUND_URL="http://127.0.0.1:3000/api/v1/inbound"
AGENTBUS_SCHEDULES_URL="http://127.0.0.1:3000/api/v1/schedules"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-90}"
HEALTH_LOG_EVERY_S=15
HEALTH_POLL_INTERVAL_S=2
WAKEUP_STALE_AFTER_MS=$(( 45 * 60 * 1000 ))
CHRIS_EMAIL="chris@chrispatten.dev"
PM2=""
PM2_LOCAL="$REPO_ROOT/node_modules/.bin/pm2"

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
    --dry-run)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Extracts the JSON array from noisy pm2 output (e.g. the ">>>> In-memory PM2
# is out-of-date" banner a version-mismatched client prints to stdout).
extract_pm2_json() {
  python3 -c "
import sys
t = sys.stdin.read()
lines = t.splitlines()
start = next((i for i, l in enumerate(lines) if l.startswith('[')), None)
if start is None:
    sys.exit(1)
sys.stdout.write('\\n'.join(lines[start:]))
"
}

# Resolves which pm2 client to use. Order: $PM2_BIN, pm2 on PATH,
# /opt/homebrew/bin/pm2, local node_modules (last resort). The first
# candidate whose `jlist` parses and carries no "out-of-date" banner (i.e.
# matches the running daemon) wins; otherwise the first existing candidate.
resolve_pm2() {
  local candidates=() c first=""
  # An explicit override is honored as-is (no daemon-match probing).
  if [ -n "${PM2_BIN:-}" ]; then
    [ -x "$PM2_BIN" ] || { log "ERROR: PM2_BIN=$PM2_BIN is not executable."; return 1; }
    PM2="$PM2_BIN"; return 0
  fi
  c="$(command -v pm2 2>/dev/null)"; [ -n "$c" ] && candidates+=("$c")
  candidates+=("/opt/homebrew/bin/pm2" "$PM2_LOCAL")
  for c in "${candidates[@]}"; do
    [ -x "$c" ] || continue
    [ -z "$first" ] && first="$c"
    local out
    out="$("$c" jlist 2>/dev/null)"
    if ! echo "$out" | /usr/bin/grep -q 'out-of-date' && echo "$out" | extract_pm2_json >/dev/null 2>&1; then
      PM2="$c"; return 0
    fi
    log "pm2 candidate $c does not match the running daemon (noise or unparsable jlist); trying next."
  done
  PM2="$first"
  [ -n "$PM2" ]
}

pm2_bus_core_status() {
  "$PM2" jlist 2>/dev/null | extract_pm2_json 2>/dev/null | python3 -c "
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

# Alternate liveness check: `pm2 pid bus-core` prints a nonzero pid when online.
pm2_bus_core_pid_alive() {
  local pid
  pid="$("$PM2" pid bus-core 2>/dev/null | /usr/bin/grep -Eo '^[0-9]+$' | tail -1)"
  [ -n "$pid" ] && [ "$pid" != "0" ] && kill -0 "$pid" 2>/dev/null
}

# Polls health for up to HEALTH_TIMEOUT_S seconds, logging progress every
# HEALTH_LOG_EVERY_S. Returns 0 if the HTTP health endpoint reports ok AND
# pm2 sees bus-core online (jlist status "online", or failing that a live
# `pm2 pid`). Catches the case where the endpoint briefly responds during a
# crash loop but pm2 is still restarting it repeatedly.
check_health() {
  local start now deadline next_log
  start="$(date +%s)"; deadline=$(( start + HEALTH_TIMEOUT_S )); next_log=$(( start + HEALTH_LOG_EVERY_S ))
  while :; do
    now="$(date +%s)"
    [ "$now" -lt "$deadline" ] || break
    local resp http_ok=0 st="n/a"
    resp="$(curl -sf --max-time 3 "$HEALTH_URL" 2>/dev/null)"
    if [ -n "$resp" ] && echo "$resp" | /usr/bin/grep -q '"ok":true'; then
      http_ok=1
      st="$(pm2_bus_core_status)"
      if [ "$st" = "online" ] || { [ "$st" = "unknown" ] && pm2_bus_core_pid_alive; }; then
        return 0
      fi
    fi
    if [ "$now" -ge "$next_log" ]; then
      log "  health poll: $(( now - start ))s/${HEALTH_TIMEOUT_S}s elapsed, http_ok=$http_ok pm2_status=$st"
      next_log=$(( now + HEALTH_LOG_EVERY_S ))
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

# Creates a durable one-shot wake-up schedule (E40) targeting system:peggy,
# fire_at = now + 10s, stale_after_ms = 45 minutes.
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
  payload="$(python3 - "$context" "$WAKEUP_STALE_AFTER_MS" <<'PYEOF'
import json, sys
from datetime import datetime, timedelta, timezone

context, stale_after_ms = sys.argv[1], int(sys.argv[2])
fire_at = (datetime.now(timezone.utc) + timedelta(seconds=10)).strftime('%Y-%m-%dT%H:%M:%SZ')
body = (
    f"[bus-core restart initiated] ({context}). "
    "Monitoring health and will report once it comes back."
)
print(json.dumps({
    "type": "once",
    "fire_at": fire_at,
    "channel": "system:peggy",
    "topic": "general",
    "sender": "safe-restart",
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
    log "Created durable wake-up schedule $sched_id (system:peggy, $context)."
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
if ! resolve_pm2; then
  log "ERROR: no pm2 binary found (PM2_BIN, PATH, /opt/homebrew/bin, local). Aborting before any restart."
  exit 1
fi
log "Using pm2: $PM2 (version $("$PM2" -v 2>/dev/null | tail -1)); health timeout ${HEALTH_TIMEOUT_S}s"

if [ -z "$NOTIFY_CHANNEL" ] || [ -z "$NOTIFY_TOPIC" ]; then
  log "No --notify-channel/--notify-topic provided - falling back to generic system/safe-restart for the durable wake-up schedule."
  NOTIFY_CHANNEL="${NOTIFY_CHANNEL:-system}"
  NOTIFY_TOPIC="${NOTIFY_TOPIC:-safe-restart}"
fi

BEFORE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEFORE_COMMIT="$(git rev-parse --short HEAD)"
log "Current branch: $BEFORE_BRANCH @ $BEFORE_COMMIT"

if [ "$DRY_RUN" = "1" ]; then
  log "DRY RUN: would create a durable wake-up schedule, then run: AGENTBUS_CONFIG=config.yaml $PM2 startOrRestart ecosystem.config.cjs"
  log "DRY RUN: polling health now (no restart performed)..."
  if check_health; then
    log "DRY RUN: health OK (pm2 status: $(pm2_bus_core_status)). A real run would restart and expect this to pass."
  else
    log "DRY RUN: health NOT OK within ${HEALTH_TIMEOUT_S}s (pm2 status: $(pm2_bus_core_status))."
  fi
  log "DRY RUN: on failure it would stash tracked changes, checkout main (no npm install), restart, and re-poll."
  log "=== dry run done ==="
  exit 0
fi

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

# Never discard uncommitted work - stash tracked changes only. Untracked
# files are left in place (they do not conflict with checkout in practice and
# stashing them with -u has swept up unrelated files before).
STASHED=0
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "Tracked uncommitted changes present - stashing before rollback (message includes timestamp for recovery)."
  git stash push -m "safe_restart auto-stash $TS" >>"$LOG_FILE" 2>&1 && STASHED=1
fi

git fetch origin main >>"$LOG_FILE" 2>&1 || true
git checkout main >>"$LOG_FILE" 2>&1
ROLLBACK_COMMIT="$(git rev-parse --short HEAD)"
log "Checked out main @ $ROLLBACK_COMMIT"

# Deliberately NO npm install/ci here. main can be far behind the working
# branch, and installing its lockfile into the shared node_modules removes or
# downgrades packages the branch needs (Nov 2, 2026 incident). The rollback
# only needs a known-good code path running.
log "Skipping npm install on rollback (would mutate node_modules the original branch depends on)."
RETURN_CMDS="git checkout $BEFORE_BRANCH"
[ "$STASHED" = "1" ] && RETURN_CMDS="$RETURN_CMDS && git stash pop"
RETURN_CMDS="$RETURN_CMDS && npm install   # only if node_modules was altered"
log "To return to the previous state: cd $REPO_ROOT && $RETURN_CMDS"

create_wakeup_schedule "post-rollback restart attempt, main@$ROLLBACK_COMMIT"

restart_bus_core

log "Checking health again after rollback (timeout ${HEALTH_TIMEOUT_S}s)..."
if check_health; then
  log "Healthy after rollback to main."
  notify_peggy "[safe-restart] bus-core failed to come up on $BEFORE_BRANCH@$BEFORE_COMMIT and was automatically rolled back to main@$ROLLBACK_COMMIT, where it is now healthy. The broken commit(s) are still on $BEFORE_BRANCH untouched (any tracked uncommitted changes were stashed, not lost). To return: $RETURN_CMDS — needs investigation before retrying."
  log "=== done (rolled back, recovered) ==="
  exit 0
fi

log "STILL UNHEALTHY after rollback to main. Emailing Chris directly (bypassing AgentBus, which is down)."
"$PM2" logs bus-core --lines 80 --nostream >>"$LOG_FILE" 2>&1 || true

EMAIL_BODY="bus-core failed to restart on ${BEFORE_BRANCH}@${BEFORE_COMMIT}, and it also failed to come back up after an automatic rollback to main@${ROLLBACK_COMMIT}.

This means AgentBus itself is down right now — Peggy cannot receive or send messages through the normal Telegram/bus path, which is why this is arriving as a direct email instead of the usual channel.

Log file: ${LOG_FILE}

Please check pm2 logs / the log file above when you're able. bus-core is currently sitting on the main branch, not ${BEFORE_BRANCH} — the broken work is preserved there untouched.

To return: cd ${REPO_ROOT} && ${RETURN_CMDS}"

if email_chris_direct "AgentBus bus-core is DOWN — manual intervention needed" "$EMAIL_BODY"; then
  log "Fallback email sent to $CHRIS_EMAIL."
else
  log "ERROR: fallback email FAILED to send. This is the worst case — bus-core is down and Chris has not been notified by any channel."
fi

log "=== done (failed to recover, see above) ==="
exit 1
