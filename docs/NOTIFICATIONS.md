# User notifications (E89)

A notification is a short-lived "needs you soon" item that any agent session, schedule or script can raise on an Intercom surface (the dial): "Leave for the dentist in 20 min", "Draft to Kate awaiting your OK". It makes the dial glow, offers up to three action buttons, and can be updated in place or cleared. It needs no agent turn to show. Contract: Intercom M1a (`data/intercom/m1-notifications-contract.md` in the Peggy workspace); the protocol it extends is [INTERCOM.md](INTERCOM.md).

## Configuration

Off by default. Needs `adapters.intercom.enabled` (surfaces are where notifications show).

```yaml
notifications:
  enabled: true
  retention_days: 14             # resolved and expired rows are deleted after this long
  api_tokens_env: [NOTIFY_TOKEN_AUTOMATIONS]   # env var NAMES; each value (16+ chars) is a Bearer token for /api/v1/notifications
  context_to_followed: true      # hand what the dial shows to the followed conversation as pending context
  # rate_limit_per_min: 30       # writes per source per minute before 429
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Registers the HTTP API, the `notification` / `attention` events and the expiry sweep. The MCP tools are always registered; with the feature off they answer that notifications are not enabled |
| `retention_days` | `14` | Age at which `resolved` and `expired` rows are deleted |
| `api_tokens_env` | `[]` | Names of env vars holding API tokens. Values shorter than 16 characters are ignored. Empty means the public API accepts nothing (the MCP tools still work) |
| `context_to_followed` | `true` | Context carry-over (below). Also makes the followed conversation a pending-context reader |
| `rate_limit_per_min` | `30` | Sliding window per `source` |

## The data model

Table `notifications` (migration 045): `id` (uuid), `key` (nullable; unique among non-terminal rows), `contact_id` (default `chris`), `title` (60 characters, longer is cut with `…`), `body` (280, nullable), `level` (`info` \| `attention` \| `urgent`, default `attention`), `state` (`active` \| `acknowledged` \| `resolved` \| `expired`), `targets` (JSON array of surface ids or `["*"]`), `actions` (at most 3 of `{label (24 characters), style?: primary\|success\|danger}`), `source` (required free label), `conversation_ref`, `acked_by`, `acked_at`, `created_at`, `updated_at`, `expires_at`.

`key` upserts: raising the same `key` while the item is `active` or `acknowledged` updates it in place, resets it to `active`, clears the acknowledgement and bumps `updated_at`. A `resolved` or `expired` key starts a new row. Terminal rows cannot be changed (409). The `resolved` state is set only by a writer (tool or API); a tap on the surface only acknowledges.

## Writers

### MCP tools

Registered for every agent (cc-pool, cc-headless, tools-only `cc.ts`), see [MCP_TOOLS.md](MCP_TOOLS.md#notifications). `notify({title, body?, level?, key?, targets?, expires_in_s?, actions?, source?})` returns `{id, key, state}`; `update_notification({id? | key?, title?, body?, level?, state?, expires_in_s?})`; `list_notifications({state?: active|open|all, limit?})` (`open` is `active` plus `acknowledged`; default `open`). The tools call `/api/v1/internal/notifications*`, which share their handlers with the public API but use the shared bus auth (`X-Bus-Token` when `bus.auth_token` is set; the tools send it automatically).

### HTTP API

For scripts and automations (Mail Watcher, the paper inbox, Home Assistant, cron). `Authorization: Bearer <token>` where the token is the value of any env var named in `notifications.api_tokens_env`; these routes skip `bus.auth_token`. See [HTTP_API.md](HTTP_API.md#notifications-e89).

```bash
curl -s -XPOST http://127.0.0.1:3000/api/v1/notifications \
  -H "Authorization: Bearer $NOTIFY_TOKEN_AUTOMATIONS" -H 'Content-Type: application/json' \
  -d '{"title":"Bill due today","body":"Citi $2,410","key":"bill-citi","level":"attention","source":"Capital OS","expires_in_s":86400}'
```

Limits: body at most 8 KB (413), 30 writes per minute per `source` (429 with `Retry-After: 60`), validation errors 400 (`{"ok":false,"error":"invalid_body","detail":"…"}`), wrong or missing token 401. Do NOT put these routes behind `tailscale serve`; keep them to loopback or the LAN. Anyone with a token can put text on the dial.

## Surface protocol additions (WebSocket v1)

Server to surface (event frames, like the others in [INTERCOM.md](INTERCOM.md#websocket-protocol-v1-apiv1intercomws)):

- `notification` (durable, with `seq`; replayed from the cursor): `{id, key, title, body, level, state, actions, source, created_at, updated_at, expires_at}`. Sent on create, update and every state change (including `resolved` and `expired`), only to surfaces named in `targets` (all surfaces for `*`).
- `attention` (ephemeral): `{level: none|info|attention|urgent, count}`: the highest level among the surface's `active` items and how many there are. `acknowledged` items do not count. Sent on every change and after `welcome`.
- After `welcome`, replay and the `activity` snapshot, the server sends a non-durable `notification` event (no `seq`) for every `active` or `acknowledged` item targeting the surface, then `attention`. A fresh client has the full open set without replaying history; a client should treat `id` + `updated_at` as authoritative when a replayed event and a snapshot disagree.

Surface to server:

- `{"type":"notification_ack","id":"…"}`: `active` becomes `acknowledged` (`acked_by` is the surface id) and the surface gets the updated `notification` and `attention`. No direct reply on success.
- `{"type":"notification_action","client_msg_id":"<uuid>","id":"…","index":N}`: acknowledges the item and submits `[tapped] <label>` into the followed conversation exactly like a surface `send` (same interaction window, silent echo, agent note). The agent note gains a line: `On the Intercom notification "<title>" (<source>, raised HH:MM)` (time in `adapters.intercom.calendar.timezone`). The answer is the `send` `ack` frame, including `interaction_id`; idempotent on `client_msg_id` (a repeat returns the stored ack even if the item has meanwhile been resolved). The inbound's metadata also carries `notification_id`.
- An unknown, terminal or untargeted id answers `{"type":"error","code":"notification_not_found"}`; a missing `client_msg_id`, non-integer `index` or an index outside `actions` answers `invalid_frame`.

Quiet hours are the client's business: the server stores only the last `state` frame and sends nothing to Telegram. Escalation of urgent items to Telegram is not built.

## Expiry and retention

The Intercom service's 60-second tick expires `active` and `acknowledged` rows past `expires_at` (state `expired`, surfaces told with `notification` + `attention`) and deletes `resolved` / `expired` rows older than `retention_days`.

## Context carry-over (`context_to_followed`)

When a notification is created, or updated with a changed title, body or level, the bus writes one hidden, context-only note into the followed conversation of the targeted surfaces (once per conversation, even when several surfaces follow the same one). It reaches that conversation's next agent turn as pending context, in the "Context shared with you since your last turn" section:

```
- [2026-11-01 00:41 EDT, just now] Intercom: Mail Watcher: [Shown on Intercom at 12:41 AM] (attention) Leave for the dentist: Dr. Alvarez at 9:00, 18 min drive. Actions: Leaving now / Snooze 10.
```

Acknowledgements, taps, resolutions and expiries write no note (a tap arrives as a message). The row is the same hidden `context_only` row `share_context` writes (`shareContextToConversation`, `src/app/context-share.ts`): no queue row, no delivery, no wake, no effect on `message_count` or `last_activity`; origin `external` labelled `Intercom: <source>`. It attaches to the conversation's newest session row, or a message-less placeholder is created when there is none. The route for the followed channel must target `cc-headless` or `cc-pool` (the runtimes that read pending context); otherwise a warning is logged and nothing is written. Notes older than `context_ttl_ms` (24 hours) are skipped.

### How pending context reaches a followed forum topic

Before E89, pending context applied only to *primary* conversations: Main, and the `general` conversation of each channel in `agents.<id>.pending_context.channels`. The Intercom surface follows a forum topic (`telegram:peggy:group:-100…` / `thread:…`), which is never primary. The smallest change: `primaryConversationChannel` (`src/app/main.ts`), the one function both readers use (the cc-pool stage `pending-context-inject` and cc-headless `runBatch`), now also returns the channel of any conversation in `followedConversationIds(config)`: the conversations (contact, channel, topic) that an enabled `adapters.intercom` surface follows. That set is empty unless `notifications.enabled` and `notifications.context_to_followed` are both true and Intercom is enabled, so a bus without notifications changes in no way, and a non-followed forum topic still gets no pending context. `pendingContextAgent` also falls back from `telegram:peggy:group:<id>` to the agent that lists `telegram:peggy`, so the DM agent's `pending_context` limits apply. Nothing else is touched: rotation, teardown, `DeliveryWorker` conversation resolution and `topic_rules` stay Main/DM-only.

A side effect worth knowing: any foreign-origin outbound message into the followed topic (for example a routine's `send_message` into that topic) is now also delivered as pending context on the next turn there, as it would be in a primary DM.

## Agent guidance (N9): notify versus message

- **notify** for short-lived "needs you soon" states: leaving time, a bill due today, a draft awaiting approval, a background job finished. Give it a `key` so it can be resolved later (`update_notification` with `state: "resolved"`).
- **message** (`reply`, `send_message`) for content.
- When background work started from an Intercom turn finishes, `notify` with `level: "info"` (or `"attention"` if a decision is needed) and a `key`, and `reply` the result.

The same rule is appended to the one-line note every Intercom-origin message carries (only when `notifications.enabled`), so the Intercom session sees it on each turn.

## Not built

Urgent escalation to Telegram while the device is quiet or offline; per-surface quiet hours on the server; snooze (an action button that sends `[tapped] Snooze 10` is just a message the agent answers by re-raising with the same `key`); a CLI.
