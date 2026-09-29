# E57 — Calendar Proposals: Updates, Telegram Buttons, Command & Fallback

| Field | Value |
|---|---|
| Epic ID | E57 |
| Dependencies | E55, E56; Telegram inline callbacks already present in `src/adapters/telegram.ts` (E51 approvals) |
| Story Count | 5 |
| Complexity | M |

Source spec: §5–6, §8.1 (update), §8.6–8.8, §11 Phase 3.

## Epic Summary

Apple offers Accept/Maybe/Decline for plain iMIP invites but not "Propose New Time", so change requests are conversational. This epic adds `calendar_update` (same UID, SEQUENCE+1), Telegram inline buttons (Accept / Decline / Change) mapped to the same ledger transitions as the Calendar app, a `/calendar` slash command, and an `--ics` mode for the SMTP fallback script.

## Exit Criteria

1. `calendar_update` re-sends METHOD=REQUEST with the same UID and incremented SEQUENCE in the original thread; status UPDATED. Per spike result, edit-in-place is verified.
2. Telegram proposal notice with inline Accept / Decline / Change buttons reusing the E51 callback machinery. Accept/Decline via Telegram transition the ledger and (per spike) send the appropriate iTIP so his calendar matches. Change prompts a conversational reply that Peggy resolves against the ledger (most recent open proposal if unambiguous, else asks).
3. If callback plumbing proves unsuitable, buttons are dropped and Telegram replies are handled conversationally; documented.
4. `/calendar` slash command lists open proposals with status and age.
5. `scripts/send_direct_email.py` gains `--ics` mode for use during bus-core outages (lives in the peggy repo; coordinate).
6. Structured logs for every send and parsed reply. Tests, docs, CHANGELOG.

## Stories

### S57.1 — `calendar_update` tool
### S57.2 — Telegram notice with inline buttons (Accept / Decline / Change)
### S57.3 — Change-request resolution (Telegram text and reply comments) against the ledger
### S57.4 — `/calendar` slash command
### S57.5 — `--ics` mode in `send_direct_email.py` and observability logging

## Out of scope (spec Phase 4)
Kate and the kids as attendees (needs its own approval design), read-only "Peggy's Suggestions" overlay calendar.
