# Resolution

## Root causes

1. **Transcripts off in every pane (symptoms 1-4).** bus-core (pm2 id 2) was started from inside a Claude Code session. `pm2 env 2` shows `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_CODE_SESSION_ID`, and related markers. The tmux server that bus-core recreated at 15:09 inherited them and passed them to every pane, so each pane's `claude` ran as a child session with transcript saving off. The 17:00 and 20:00 scans did run: pane 2 posted `tool-status` at 20:00:38 and 20:00:42. They lived only in that process. At 20:20:26 the one-shot schedule relaunched pane 2 (`model=sonnet`) with `--resume bd558a9d`, which replayed the JSONL as last saved on Friday. That wiped the in-memory scan turns. The ghost-turn hypothesis (1) is not needed.
2. **Stale-sender rejection (symptom 5).** The log fields were misleading. `expected_conversation_id` was the conversation the send *targeted*, derived from recipient, channel, and topic. `actual_conversation_id` was the pane's lease. Pane 2 (leased to the scheduled conversation `44040e81`) called `send_message` to Chris's DM (`6a8face`). The guard rejected it because it guarded proactive sends as well as replies. The lease table had not drifted (hypothesis 3).

## Fix

- `src/pool/pane.ts`: the launch line unsets `INHERITED_CLAUDE_SESSION_VARS` and exports `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`.
- `src/http/api.ts`: the lease guard applies only to reply-linked sends (`reply_to` or `metadata.conversation_id`). The log fields are renamed `reply_conversation_id` and `lease_conversation_id`.

## Deploy

Restart bus-core, then relaunch the peggy panes (kill `peggy-pool`; the pool recreates it) so each `claude` starts with the new launch line. Optionally run `pm2 restart bus-core --update-env` from a plain shell to clear the markers at the source.

## Deferred

Asks 1, 2, 5, and 6 (delivery tracing and alerting, fresh session per cron fire, `make logs-dump`) are in `_bmad-output/maintenance-backlog.md`.
