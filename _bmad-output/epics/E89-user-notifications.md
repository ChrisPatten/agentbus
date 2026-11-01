# E89 — User Notifications (attention system)

| Field | Value |
|---|---|
| Epic ID | E89 |
| Dependencies | E91 (surfaces and socket), E86 (choice-tap path for actions) |
| Story Count | 5 |
| Estimated Complexity | L |
| Status | Scoped — not started |

Source: `data/intercom/intercom-prd.md` v1.1, section 6 (N1 to N9).

## Epic Summary

A first-class notification object that any session, schedule or automation can raise, update and clear, aimed at one or more surfaces, so Intercom can show "needs you soon" without an agent turn.

## Scope

- **S89.1 Data model (N1).** `notifications` table: `id`, `key` (unique while unresolved, for upsert), `contact_id`, `title` (60), `body` (280), `level` (`info`, `attention`, `urgent`), `state` (`active`, `acknowledged`, `resolved`, `expired`), `targets` (surface ids or `*`), `actions` (E74 item shape), `source`, `conversation_ref`, timestamps and `expires_at`.
- **S89.2 MCP tools and HTTP API (N2, N3).** `notify`, `update_notification`, `list_notifications`; token-authenticated `POST/PATCH/GET /api/v1/notifications` for Mail Watcher, the paper inbox, Home Assistant and cron; size and rate limits per source.
- **S89.3 Delivery and acknowledgement (N4, N5).** Durable `notification` events with replay; acknowledge and action frames; an action tap enters the followed conversation like a choice tap and records surface and time.
- **S89.4 Attention state, quiet handling, expiry (N6 to N8).** Highest unacknowledged level drives the glow; queue and count while quiet; optional urgent escalation to Telegram; expiry sweep on the 60-second tick and retention.
- **S89.5 Agent guidance (N9).** Docs and injected guidance on notify versus message.
