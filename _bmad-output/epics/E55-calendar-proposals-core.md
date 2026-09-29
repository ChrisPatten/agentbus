# E55 — Calendar Proposals: Spike, Ledger & Outbound Invites

| Field | Value |
|---|---|
| Epic ID | E55 |
| Dependencies | Email adapter (`src/adapters/email.ts`, `email-thread.ts`), MCP tool registry (`src/mcp/`), config schema |
| Story Count | 6 |
| Complexity | M |

Source spec: `peggy-claude-code/data/calendar-invites-spec.md` (Sep 28, 2026), §3, §8.1–8.3, 8.9, §9, §10, §11 Phases 0–1. Sibling epics: E56 (inbound RSVP + scheduler), E57 (updates, Telegram buttons, tooling), plus Peggy-side skill work tracked in the peggy repo.

## Epic Summary

Let Peggy send Mr. Patten a calendar invitation (iMIP, `METHOD=REQUEST`) from `Peggy.pattenbot@icloud.com`. The invitation is the consent step: nothing lands on his calendar until he accepts. This epic delivers the spike that de-risks the iCloud behavior, the `calendar_proposals` ledger, the ICS builder, outbound send via the email adapter, and the `calendar_propose` / `calendar_cancel` / `calendar_list_proposals` MCP tools with server-side guardrails.

## Entry Criteria

- Peggy's iCloud SMTP send path works (nodemailer, allowlist).
- Mr. Patten adds Peggy.pattenbot@icloud.com to Contacts (verify during the spike; iCloud may otherwise route to Junk Invitations).

## Exit Criteria

1. Spike findings for spec §10 Q1–Q6 written into this file; decision recorded: option A (iMIP email) or D (CalDAV scheduling).
2. Migration adds `calendar_proposals` (uid, sequence, status, title, start, end, location, notes_summary, source channel/message id/signal hash, created_at, last_sent_at, responded_at, response_comment, nudge_sent).
3. ICS builder emits valid VEVENT with VTIMEZONE America/New_York, UID, DTSTAMP, SEQUENCE, ORGANIZER, ATTENDEE RSVP=TRUE, STATUS TENTATIVE, and `X-PEGGY-PROPOSAL`.
4. Email adapter send path accepts `icalEvent` (REQUEST/CANCEL) and reuses threading.
5. MCP tools `calendar_propose`, `calendar_cancel`, `calendar_list_proposals` registered with validation: attendee on allowlist, start not in the past, caps (3 per scan, 5 per day, 20 open) enforced server-side, signal-hash dedupe.
6. `calendar:` config section (organizer, allowed attendees, caps, nudge/expiry windows, default duration, timezone).
7. Tests green, `tsc --noEmit` clean, docs + CHANGELOG.

## Stories

### S55.1 — Spike: iCloud iMIP behavior
Send one hand-built invite via nodemailer `icalEvent` from Peggy's account. Answer §10 Q1–Q6: delivery/junk filter and Contacts requirement; which of his addresses is bound to iCloud Calendar; where accepted events land; whether Accept produces a REPLY email in Peggy's INBOX or is handled server-side (if server-side, fall back to option D CalDAV polling and re-scope E56); whether STATUS TENTATIVE renders as tentative; SEQUENCE update and CANCEL edit-in-place vs duplicate. Gate for the rest of the epic.

### S55.2 — Ledger migration and data access
`calendar_proposals` table, status enum (DRAFTED, SENT, ACCEPTED, TENTATIVE, DECLINED, CHANGE_REQUESTED, UPDATED, CANCELLED, EXPIRED), repo module with transition validation, unit tests.

### S55.3 — ICS builder (`src/calendar/`)
Pure functions building REQUEST/CANCEL calendars; snapshot tests including timezone and all-day cases.

### S55.4 — Email adapter `icalEvent` send path
Extend the send path and threading so later updates land in the original thread. Respect the recipient allowlist.

### S55.5 — MCP tools + guardrails
`calendar_propose` (builds ICS, writes ledger, sends, status SENT), `calendar_cancel`, `calendar_list_proposals(status?)`. Server-side caps, past-date rejection, allowlist, dedupe on signal hash. Structured logs on every send.

### S55.6 — Config and docs
`calendar:` schema block, defaults, `agentbus-config.yaml` example, docs, CHANGELOG.
