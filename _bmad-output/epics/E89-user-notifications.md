# E89 — User Notifications (attention system)

| Field | Value |
|---|---|
| Epic ID | E89 |
| Dependencies | E91 (surfaces and socket), E86 (choice-tap path for actions) |
| Story Count | 6 |
| Estimated Complexity | L |
| Status | Backend complete (S89.1-S89.5) on `feat/e89-notifications-core`; web app screens are in E93 on its own branch; live check pending |

Source: `data/intercom/intercom-prd.md` v1.1, section 6 (N1 to N9), refined by the M1a contract (`data/intercom/m1-notifications-contract.md`, which supersedes the PRD where they differ).

## Epic Summary

A first-class notification object that any session, schedule or automation can raise, update and clear, aimed at one or more surfaces, so Intercom can show "needs you soon" without an agent turn.

## Scope

- **S89.1 Data model (N1). Done.** `notifications` table: `id`, `key` (unique while unresolved, for upsert), `contact_id`, `title` (60), `body` (280), `level` (`info`, `attention`, `urgent`), `state` (`active`, `acknowledged`, `resolved`, `expired`), `targets` (surface ids or `*`), `actions` (E74 item shape), `source`, `conversation_ref`, timestamps and `expires_at`.
- **S89.2 MCP tools and HTTP API (N2, N3). Done.** `notify`, `update_notification`, `list_notifications`; token-authenticated `POST/PATCH/GET /api/v1/notifications` for Mail Watcher, the paper inbox, Home Assistant and cron; size and rate limits per source.
- **S89.3 Delivery and acknowledgement (N4, N5). Done.** Durable `notification` events with replay; acknowledge and action frames; an action tap enters the followed conversation like a choice tap and records surface and time.
- **S89.4 Attention state, quiet handling, expiry (N6 to N8). Done** (quiet handling is client-side per the contract; Telegram escalation is not built). Highest unacknowledged level drives the glow; queue and count while quiet; optional urgent escalation to Telegram; expiry sweep on the 60-second tick and retention.
- **S89.5 Agent guidance (N9). Done.** Docs and injected guidance on notify versus message.
- **S89.6 Context carry-over. Done.** Everything shown on the dial is written as a hidden context-only note into the followed conversation (`notifications.context_to_followed`) and a conversation an enabled Intercom surface follows now reads pending context (`followedConversationIds`, `primaryConversationChannel`). Promoted from the backlog idea "Intercom: pushes from other sessions carry into the next Intercom turn".

## Delivered

Migration 045; `src/intercom/notifications-store.ts`; notification methods on `IntercomService`; `src/http/notifications-routes.ts`; `src/mcp/tools/notifications.ts`; `notifications` config block; `shareContextToConversation` in `src/app/context-share.ts`. Docs: `docs/NOTIFICATIONS.md`, INTERCOM.md, MCP_TOOLS.md, HTTP_API.md, CC_POOL_ADAPTER.md, site-docs Intercom, MCP tools, HTTP API and configuration pages.

## Deviations from the contract

- MCP tools call `/api/v1/internal/notifications*` (shared bus auth) rather than the Bearer-token routes, as the contract allows; both share handlers.
- Over-size bodies answer 413 (Fastify's body limit), not 400.
- The snapshot after `welcome` is non-durable `notification` events (no `seq`).
- `notifications.enabled` defaults to `false` (opt-in); `rate_limit_per_min` is configurable.
- `contact_id` and `conversation_ref` are accepted on create (not in the contract's input list).
- Untargeted or unknown surface ids in `targets` are accepted and simply deliver nowhere.

## Known gaps

Telegram escalation of urgent items; server-side quiet hours; the web app's Needs-you screen (E93 branch); live check on the real bus.

