#!/usr/bin/env bash
#
# Smoke test for E27 (generic thread store) + E28 (Telegram group topics).
#
# Read-only / non-destructive: every check here either GETs, or POSTs to an
# endpoint that fails fast before touching Telegram (create_telegram_topic
# against a DM, typing/tool-status against a bogus channel). Nothing here
# sends a real message through a live bot. Run it against a running bus-core
# (pm2 or `npx tsx src/index.ts`).
#
# Usage: ./scripts/smoke-e27-e28.sh [base_url] [db_path]
#   base_url defaults to http://localhost:3000
#   db_path defaults to ~/.agentbus_data/agentbus.db

set -uo pipefail

BASE_URL="${1:-http://localhost:3000}"
DB_PATH="${2:-$HOME/.agentbus_data/agentbus.db}"

PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "  OK   $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }

json_get() { # $1=json $2=jq-ish path via python
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d$2)" "$1" 2>/dev/null
}

echo "== Bus health =========================================================="
HEALTH=$(curl -s "$BASE_URL/api/v1/health")
if echo "$HEALTH" | grep -q '"status":"healthy"'; then
  pass "GET /api/v1/health -> healthy"
else
  fail "GET /api/v1/health -> $HEALTH"
fi

echo
echo "== E27: generic thread store (DB-level) ================================"
if [ -f "$DB_PATH" ]; then
  HAS_THREADS=$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='threads';" 2>/dev/null)
  HAS_EMAIL_THREADS=$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='email_threads';" 2>/dev/null)
  MIGRATION_12=$(sqlite3 "$DB_PATH" "SELECT version FROM schema_migrations WHERE version=12;" 2>/dev/null)

  [ "$HAS_THREADS" = "threads" ] && pass "threads table exists" || fail "threads table missing"
  [ -z "$HAS_EMAIL_THREADS" ] && pass "email_threads table gone (migrated away)" || fail "email_threads still present"
  [ "$MIGRATION_12" = "12" ] && pass "migration 012 (generic thread store) recorded" || fail "migration 012 not recorded"

  ROW_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM threads;" 2>/dev/null)
  echo "  INFO threads table has $ROW_COUNT row(s) (email + any Telegram group topics)"
else
  fail "db not found at $DB_PATH — skipping DB checks"
fi

echo
echo "== E28: adapter list ===================================================="
ADAPTERS=$(curl -s "$BASE_URL/api/v1/adapters")
echo "$ADAPTERS" | grep -q '"ok":true' && pass "GET /api/v1/adapters responds ok" || fail "GET /api/v1/adapters failed"
TELEGRAM_ID=$(python3 -c "
import json,sys
d = json.loads(sys.argv[1])
for a in d.get('adapters', []):
    if a['id'].startswith('telegram'):
        print(a['id']); break
" "$ADAPTERS")
if [ -n "$TELEGRAM_ID" ]; then
  pass "found a configured Telegram adapter: $TELEGRAM_ID"
else
  echo "  WARN no Telegram adapter configured — skipping Telegram-specific checks"
fi

echo
echo "== E28: channel resolution (AdapterInstance.ownsChannel) ================"
if [ -n "$TELEGRAM_ID" ]; then
  RESOLVE_DM=$(curl -s "$BASE_URL/api/v1/adapters/resolve?channel=$TELEGRAM_ID")
  echo "$RESOLVE_DM" | grep -q '"exists":true' \
    && pass "resolve exact DM channel ($TELEGRAM_ID) -> exists:true" \
    || fail "resolve exact DM channel -> $RESOLVE_DM"

  FAKE_GROUP="${TELEGRAM_ID}:group:-1009999999999"
  RESOLVE_GROUP=$(curl -s "$BASE_URL/api/v1/adapters/resolve?channel=$FAKE_GROUP")
  echo "$RESOLVE_GROUP" | grep -q '"exists":true' \
    && pass "resolve dynamically-derived group channel ($FAKE_GROUP) -> exists:true (ownsChannel)" \
    || fail "resolve dynamic group channel -> $RESOLVE_GROUP"
fi

RESOLVE_UNKNOWN=$(curl -s "$BASE_URL/api/v1/adapters/resolve?channel=definitely-not-a-real-channel")
echo "$RESOLVE_UNKNOWN" | grep -q '"exists":false' \
  && pass "resolve unrelated channel -> exists:false" \
  || fail "resolve unrelated channel -> $RESOLVE_UNKNOWN"

RESOLVE_MISSING=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/v1/adapters/resolve")
[ "$RESOLVE_MISSING" = "400" ] \
  && pass "resolve with no channel param -> 400" \
  || fail "resolve with no channel param -> HTTP $RESOLVE_MISSING"

echo
echo "== E28: create_telegram_topic guardrails (no live Telegram call made) ==="
if [ -n "$TELEGRAM_ID" ]; then
  TOPIC_ON_DM=$(curl -s -X POST "$BASE_URL/api/v1/adapters/$TELEGRAM_ID/topics" \
    -H "Content-Type: application/json" -d '{"name":"smoke-test"}')
  echo "$TOPIC_ON_DM" | grep -q 'group-only' \
    && pass "create_telegram_topic on a DM channel rejected with 'group-only'" \
    || fail "create_telegram_topic on a DM channel -> $TOPIC_ON_DM"
fi

TOPIC_NO_ADAPTER=$(curl -s -X POST "$BASE_URL/api/v1/adapters/nonexistent/topics" \
  -H "Content-Type: application/json" -d '{"name":"x"}')
echo "$TOPIC_NO_ADAPTER" | grep -q 'No adapter registered' \
  && pass "create_telegram_topic on unknown channel -> clear 'no adapter' error" \
  || fail "create_telegram_topic on unknown channel -> $TOPIC_NO_ADAPTER"

TOPIC_NO_NAME=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/v1/adapters/telegram/topics" \
  -H "Content-Type: application/json" -d '{}')
[ "$TOPIC_NO_NAME" = "400" ] \
  && pass "create_telegram_topic with no name -> 400" \
  || fail "create_telegram_topic with no name -> HTTP $TOPIC_NO_NAME"

echo
echo "== E28: typing/tool-status fire-and-forget safety ======================="
TYPING_BOGUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/v1/adapters/nonexistent/typing" \
  -H "Content-Type: application/json" -d '{"contact_id":"contact:nobody"}')
[ "$TYPING_BOGUS" = "200" ] \
  && pass "POST .../typing on unknown channel still 200s (silent no-op)" \
  || fail "POST .../typing on unknown channel -> HTTP $TYPING_BOGUS"

TOOLSTATUS_BOGUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/v1/adapters/nonexistent/tool-status" \
  -H "Content-Type: application/json" -d '{"contact_id":"contact:nobody","text":"x"}')
[ "$TOOLSTATUS_BOGUS" = "200" ] \
  && pass "POST .../tool-status on unknown channel still 200s (silent no-op)" \
  || fail "POST .../tool-status on unknown channel -> HTTP $TOOLSTATUS_BOGUS"

echo
echo "========================================================================="
echo "Result: $PASS passed, $FAIL failed"
echo
echo "The following require a REAL Telegram group and cannot be smoke-tested"
echo "without live side effects — verify by hand against a topic-enabled group"
echo "the bot is a member of:"
echo "  1. Post in the group's General area -> reply lands back in General,"
echo "     distinct session from your DM (check 'sessions' table: different"
echo "     conversation_id / channel = '<bot>:group:<chatId>')."
echo "  2. Create a forum topic in Telegram UI, post in it -> a 'threads' row"
echo "     appears keyed by that group's channel; reply lands in the same topic."
echo "  3. Ask the agent to call create_telegram_topic (optionally with a"
echo "     'context' string) -> new topic appears in Telegram; first message"
echo "     you post there should reflect the injected context in the agent's"
echo "     reply; a second message should NOT re-inject it."
echo "  4. Have two people (or you, twice) run tool calls in two different"
echo "     topics of the same group at once -> each topic's live tool-call"
echo "     status message stays in its own topic, never in General."
echo "  5. Quote-reply to an OLDER message in a group/DM -> agent's answer is a"
echo "     native Telegram reply quote. Quote-reply to the MOST RECENT message"
echo "     -> agent's answer sends as a plain message (no quote — by design)."
echo "  6. /stop mid-turn in a group topic -> the live status draft in THAT"
echo "     topic is finalized with 'Stopped by user', not one in General or DM."

[ "$FAIL" -eq 0 ]
