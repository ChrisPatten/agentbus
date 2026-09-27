# Bug report: scheduled Email Watch scans fire and "complete" but leave no trace; pool guard rejects sends as stale sender

- **Reported:** 2026-09-26 (Sat) ~22:40 ET, by Peggy on Chris's request
- **Component:** cc-pool adapter (`peggy` pool, tmux session `peggy-pool`), scheduler, pool-guard outbound lease check
- **Version:** bus-core 0.13.0 (`make health`), pm2 process `bus-core` (id 2)
- **Severity:** high. Scheduled work silently doesn't happen and nothing alerts; user-facing output from scheduled jobs is blocked on the same pane.
- **Related, already known:** recurring "stale sender" lease-guard rejections (Sep 19-25), E49 in-band approvals, Sep 21 frozen-pane incident. See Peggy memory `project_agentbus_session_architecture.md`.

## Summary

The 17:00 and 20:00 ET Email Watch scans on 2026-09-26 (schedule `9ead1b23-ddb5-403d-ab4d-55c1e8e697d7`, cron `0 8-20/3 * * *`, model haiku, topic `sched:email-watch`) were fired by the scheduler, acked, and reported `turn-ended` by bus-core. But:

1. **No scan turn appears in the pane they were supposedly delivered to** (`peggy-pool:2`). Its UI shows Friday's scans, then nothing until an unrelated 20:21 turn.
2. **No daily-memory entry was written** for either scan (`memory/daily/2026-09-26.md` has 08:00, 11:00, 14:00 scan entries, then none). Per the `email-scan` skill even a quiet scan writes one line.
3. **A skill change made at ~17:50 was never picked up** by the 20:00 scan (new Step 5 "Refresh the Kindle dashboard"), and the artifact it should have updated (`scripts/kindle/out/spec.json`) was untouched.
4. **Claude Code's own session transcript for that pane has not been written since Friday.** The JSONL for session `bd558a9d-...` (pane 2) ends at `2026-09-26T00:00:38Z` (Friday 8 PM ET). Each pane shows the banner `Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 to keep future transcripts`.
5. **At 20:20:48 the outbound guard rejected `agent:peggy-pool-2` as a stale sender** with an expected conversation id that `make pool` says belongs to a *different pane*.

So scheduled scans currently look healthy from the bus (fired, acked, turn-ended) and are unobservable from every other angle. That is the worst failure mode: silent.

## Impact

- Chris noticed only because he asked why a Kindle dashboard "last refreshed" time hadn't moved after the 8 PM scan.
- Any scan since at least the 17:00 fire (possibly earlier; the 08:00/11:00/14:00 entries exist but their pane is not identified) may not have run its real work.
- Peggy could not message Chris on Telegram from pane 2 afterward (stale sender). She used the `scripts/send_direct_email.py` SMTP bypass. This is the same failure mode as Sep 23-24.

## Timeline (all ET unless noted; bus-core pm2 log timestamps are local ET, `make pool` timestamps are UTC)

- **15:05-15:09** tmux server was unreachable (`error connecting to /private/tmp/tmux-501/default`). `Pane launch failed for peggy-pool:1`, conversation `d923645c...` parked, `reconcileLiveness: killWindow failed` repeated every minute until 15:09:21, when `peggy-pool` was recreated. (See `evidence/pm2-logs-err-last150.txt` lines ~35-108.)
- **17:00:25** `[pool:peggy] launching peggy-pool:2 model=haiku (source=schedule)` then `[scheduler] Fired schedule 9ead1b23 (Email Watch)`. `POST /pool/peggy/turn-ended` at 17:00:30 (5 s) and 17:00:49.
- **~17:50** `email-scan` SKILL.md edited (Step 5 added).
- **20:00:22** `[scheduler] Fired schedule 9ead1b23 (Email Watch)`, message acked, typing posted, `tool-status` at 20:00:38 and :42, `turn-ended` at 20:00:46 (24 s). (`evidence/pm2-logs-out-last400.txt` lines 328-334.)
- **20:20** Chris asks why the Kindle still shows 17:10. Peggy (in `peggy-pool:1`) checks: schedule `fire_count` went 104 -> 105 at `last_fired_at 2026-09-27T00:00:22Z`, but no daily entry, no spec change.
- **20:20:48** `[pool-guard] stale sender: sender=agent:peggy-pool-2 expected_conversation_id=6a8faccec3b5b43f... actual_conversation_id=44040e8121c6eeb5...`
- **20:21** the one-shot verification turn (schedule `ed8c20f8`, sonnet, topic `general`) does run in `peggy-pool:2`, cannot send to Telegram, sends by SMTP bypass.

## Evidence (in `evidence/`)

- `make-pool.json`: `make pool` output at 22:37 ET. Three leased panes, two free grow panes, `parked.count: 0`.
- `make-health.json`: `make health`. bus-core reports `healthy`, adapters online (this is why it looks fine from outside).
- `make-pool-capture-N1|N2|N3.txt`: `make pool-capture N=<n> LINES=120`.
- `tmux-pane2-full-scrollback.txt`, `tmux-pane3-full-scrollback.txt`: `tmux capture-pane -S -3000`.
- `pm2-logs-err-last150.txt`, `pm2-logs-out-last400.txt`: `pm2 logs bus-core --nostream`, ANSI stripped.
- Claude Code session file (not copied, 60 MB): `~/.claude/projects/-Users-chrispatten-workspace-peggy-claude-code/bd558a9d-9297-466b-9146-8f2ffd8e0106.jsonl`; last message timestamp `2026-09-26T00:00:38.459Z`.

### Key observations from `make pool` (22:37 ET)

| pane | agent | conversation | leased (UTC) | last activity (UTC) |
|---|---|---|---|---|
| `peggy-pool:1` | `agent:peggy-pool-1` | `d923645c...` (Chris's Telegram topic) | 2026-09-26T19:09:21Z | 2026-09-27T02:37:04Z |
| `peggy-pool:2` | `agent:peggy-pool-2` | `44040e81...` | 2026-09-26T21:00:21Z | 2026-09-27T00:21:00Z |
| `peggy-pool:3` | `agent:peggy-pool-3` | `6a8faccec...` | 2026-09-26T22:26:39Z | 2026-09-27T00:34:16Z |

`peggy:grow-1`, `peggy:grow-2` free. Note the guard at 20:20:48 (= 00:20:48Z) said `agent:peggy-pool-2` was expected to serve `6a8face...`, but `make pool` shows `6a8face...` on **pool-3**, leased at 22:26:39Z (18:26 ET), i.e. two hours *before* the rejection. The guard's agent -> conversation mapping disagrees with the pool table.

## What is confirmed vs. unknown

**Confirmed**
- Scheduler fired both scans and bus-core recorded ack + `turn-ended` for them.
- Pane 2's UI has no turn labeled 17:00 or 20:00 today (`grep "done [0-9]+:[0-9]+ (AM|PM)"` finds only the 20:21 verification turn). Friday's scans are the newest scan turns in it.
- No daily-memory entries for those scans; no effect on any artifact the updated skill would have touched.
- Session JSONL for pane 2 stopped at Friday 8 PM; panes 1-3 all print the transcript-saving-off warning.
- Guard rejection at 20:20:48 with mismatched ids as described.

**Unknown / hypotheses (please investigate, none verified)**
1. `turn-ended` may be posted by a Stop hook for a pane that received nothing, or received the message while not accepting input (a resumed session showing a prompt), and immediately "ended". A turn that ends in 5 s (17:00:30) with no visible transcript is consistent with this. What defines "turn ended" and does the bus require evidence a turn actually started?
2. `CLAUDE_CODE_CHILD_SESSION` inherited into pane launch env is disabling transcript persistence. If the same inheritance affects hook or MCP behavior, it may explain the ghost turns. Who sets that variable, and should the pool strip it when launching `claude`?
3. Agent -> conversation lease bookkeeping drift: a conversation that has been re-leased (or parked/unparked after the 15:05-15:09 tmux outage) is still recorded against its old agent id, so the guard rejects legitimate sends and possibly misroutes inbound. The 15:05 launch-failure/parking storm predates every symptom today.
4. Scheduled topics (`sched:email-watch`) resuming an old long-lived Claude session (`bd558a9d`, 60 MB, first written Aug 21, `--resume`) may carry stale context (skills loaded earlier, no re-read of SKILL.md), which would explain scans ignoring a skill edit. This is separate from the ghost-turn problem and probably real on its own.

## Reproduction

Not deterministic. Observed sequence: pool recreated after a tmux server disappearance -> scheduled fire launches a pane with `model=haiku (source=schedule)` -> bus logs fire/ack/turn-ended -> pane UI and transcript show nothing. To check next time: after any scheduled fire, compare (a) `pm2 logs bus-core` turn-ended lines, (b) `make pool-capture N=<pane>`, (c) the newest timestamp in that pane's session JSONL, (d) the daily memory file.

## Suggested fixes / asks

1. **Fail loud, not silent.** If a scheduled trigger produces no tool calls / no transcript growth within N seconds, mark the delivery failed, retry once, then alert Chris out-of-band (the SMTP bypass path exists).
2. **Record which pane got each scheduled message** (schedule id -> message id -> pane id -> claude session id) in a queryable place; today there is no way to answer "where did the 20:00 scan go" from `make` targets or logs.
3. Investigate `CLAUDE_CODE_CHILD_SESSION` inheritance at pane launch and set `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` (or unset the marker) so transcripts exist for debugging.
4. Reconcile the guard's agent -> conversation table with the pool table on every lease change, and expose the guard's view in `make pool`/`GET /api/v1/pool` so mismatches are visible.
5. Consider a fresh Claude session per scheduled fire (or a forced `/clear` + skill re-read) for cron topics so skill edits take effect.
6. `make logs`/`logs-err` follow forever and hang non-interactive callers; add a `--nostream` variant (e.g. `make logs-dump LINES=`). Peggy had to call `pm2 logs ... --nostream` directly.

## Workarounds in place

- Kindle dashboard: Peggy refreshed it manually at 20:20 and proposed a non-LLM launchd job that re-renders every 30 minutes so the display stays fresh regardless of scan health.
- Undeliverable Telegram sends from a stale pane go out via `scripts/send_direct_email.py`.
