# E56 — Calendar Proposals: Inbound RSVP Handling & Expiry Scheduler

| Field | Value |
|---|---|
| Epic ID | E56 |
| Dependencies | E55 (ledger, ICS module, tools); S55.1 spike result (REPLY arrives in INBOX) |
| Story Count | 4 |
| Complexity | M |

Source spec: §4 steps 5–6, §8.4–8.5, §12 (zero LLM turns on plain accepts/declines).

## Epic Summary

Handle Mr. Patten's answers deterministically. Inbound `text/calendar` `METHOD=REPLY` messages update the ledger and stop, with no agent turn unless something needs a human-grade reaction. A lightweight internal (non-LLM) job nudges after 24 hours and expires or cancels stale proposals, per the Sep 5 finding that background LLM turns dominate spend.

## Exit Criteria

1. Email adapter `fetchNew` inspects parsed parts for `text/calendar` before building the agent-facing message. A REPLY for a known UID maps PARTSTAT to ACCEPTED / TENTATIVE / DECLINED, records comment and `responded_at`, and is not enqueued to an agent.
2. An agent turn is enqueued only when the reply has a comment, is a COUNTER (recorded as CHANGE_REQUESTED), or has an unknown UID. The message is tagged with the proposal UID.
3. Raw `.ics` attachments are suppressed from the agent's attachment view.
4. Declines record the source signal hash so the same signal is not re-proposed.
5. Scheduler job (no LLM): 24h after SENT with no response, one Telegram nudge (`nudge_sent` guards duplicates); at event start with no response, send `METHOD=CANCEL`, ledger EXPIRED.
6. Tests with fixture REPLY/COUNTER/unknown-UID emails and fake-clock scheduler tests. Docs + CHANGELOG.

## Stories

### S56.1 — iTIP parser (REPLY/COUNTER)
Parse `text/calendar` parts; extract UID, PARTSTAT, comment, SEQUENCE; validate attendee against the ledger row.

### S56.2 — Inbound routing in the email adapter
Ledger update and short-circuit; enqueue conditions per exit criterion 2; attachment suppression; idempotency on redelivered messages.

### S56.3 — Decline suppression
Persist signal hash on decline; `calendar_propose` rejects a re-proposal of a declined signal.

### S56.4 — Nudge and expiry job
Internal scheduler task, Telegram nudge via existing send path, CANCEL send and EXPIRED transition, restart-safe.
