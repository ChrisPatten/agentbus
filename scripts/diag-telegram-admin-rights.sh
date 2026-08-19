#!/usr/bin/env bash
# Read-only diagnostic: bypasses our code entirely and asks Telegram directly
# what it thinks this bot's rights are in a given chat. Used to determine
# whether a create_telegram_topic "lacks Manage Topics" rejection is a real
# Telegram-side permission state vs. a bug in our getChatMember/admin-rights
# check (src/adapters/telegram.ts createTopic()).
#
# Usage: scripts/diag-telegram-admin-rights.sh <chat_id>
#   e.g.: scripts/diag-telegram-admin-rights.sh -1003977797157
set -euo pipefail

CHAT_ID="${1:?Usage: $0 <chat_id>  (e.g. -1003977797157)}"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TOKEN="${TELEGRAM_BOT_TOKEN_PEGGY:?TELEGRAM_BOT_TOKEN_PEGGY not set (check .env)}"
API="https://api.telegram.org/bot${TOKEN}"

echo "== getMe (this bot's identity) =="
ME_JSON="$(curl -s "${API}/getMe")"
echo "$ME_JSON" | python3 -m json.tool
BOT_ID="$(echo "$ME_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["id"])')"
echo
echo "Resolved bot user_id: $BOT_ID"
echo

echo "== getChat (chat_id=$CHAT_ID) — confirms is_forum, type, id match =="
curl -s "${API}/getChat" -d "chat_id=${CHAT_ID}" | python3 -m json.tool
echo

echo "== getChatMember (chat_id=$CHAT_ID, user_id=$BOT_ID) — raw rights =="
curl -s "${API}/getChatMember" -d "chat_id=${CHAT_ID}" -d "user_id=${BOT_ID}" | python3 -m json.tool
echo

echo "== getChatAdministrators (chat_id=$CHAT_ID) — full admin list for cross-check =="
curl -s "${API}/getChatAdministrators" -d "chat_id=${CHAT_ID}" | python3 -m json.tool
