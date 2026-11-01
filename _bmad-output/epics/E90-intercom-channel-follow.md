# E90 — Intercom Channel Follow

| Field | Value |
|---|---|
| Epic ID | E90 |
| Dependencies | E79 (status lines), E83 (Telegram DM as a primary conversation on cc-pool), E86 (shared choice-tap path, later stories), E48 (cc-pool) |
| Related | E89 (user notifications), E91 (the surface), E92 (voice), E93 (iPhone web prototype) |
| Story Count | 9 (7 done, 2 not started) |
| Estimated Complexity | L |
| Status | M0 backend built on `feat/e90-intercom-core` (not merged, not live). S90.8 and S90.9 not started |

Sources: `data/intercom/intercom-prd.md` v1.1 and the binding `data/intercom/m0-contract.md` (Peggy's workspace, 2026-10-31). Where the two disagree, the M0 contract wins.

---

## Epic Summary

A surface (the iPhone web app now, the Compact device later) follows one existing conversation, normally Chris's Telegram DM with Peggy. It always shows the agent's activity and status line there. What Chris sends from the surface enters that conversation exactly as a Telegram message from him would, so the agent, session and pane are the real ones, and the reply goes to Telegram as usual. While an interaction window is open the agent's replies in that conversation also reach the surface as short glance lines. Nothing else in the conversation does. The follow target is configuration, not a separate chat.

## Design Decisions

| Decision | Choice |
|---|---|
| Follow target | `{contact, channel, topic?}` per surface. DM: `{chris, telegram:peggy}`. Forum topic: add `topic: thread:<hash>`. The conversation id is `computeConversationId(contact, channel, topic or 'general')`, the pipeline's own value. |
| Injecting a surface send | `processInbound` with `channel` = the follow channel, `sender` = `contact:<id>` (contact resolve accepts the canonical form), no new pipeline stage. It therefore gets the same dedup, route resolve, pool route resolve and transcript logging as a Telegram message. |
| Metadata | `origin: "intercom"`, `surface_id`, `interaction_id`, `client_msg_id`. Existing `metadata.origin` readers (E69) only accept objects, so the string is ignored by them. |
| Agent awareness | One `<agentbus-system kind="intercom">` block via `InboundSystemOptions.blocks`: attached after the pipeline, never stored in the transcript, shown to the agent with the message. |
| Echo | Sent straight through the followed channel's adapter (`adapter.send`), not through the queue, so `DeliveryWorker` never sees it and it can never be routed as inbound or counted as a reply. The Telegram adapter posts it as plain text, silent, without a link card, bypassing the typing loop and the status draft. |
| Reply feed | `DeliveryWorker.onDelivered` hook, called after the adapter confirmed delivery, so a failed Telegram send is not shown on the dial. |
| Activity feed | The existing `/typing` and `/tool-status` routes and the Stop hook's `turn-ended` events call the service. No new hook, no changes to the pane scripts. |
| Window | Opens on a surface send (refreshes if open), closes `interaction_grace_s` after `turn-ended`; any running signal cancels a pending close; `activity_stale_s` is a backstop for a missing Stop hook. |
| Idempotency | `intercom_sends` keyed by `(surface_id, client_msg_id)` stores the ack. The pipeline's dedup still applies to different ids with identical text. |
| Glance | Optional `glance` on `reply` and `send_message`, stored in `metadata.glance`, derived in `POST /api/v1/messages` when absent. |

## Exit Criteria (M0)

1. A surface send arrives in the pool pane's DM session as a message from `contact:chris` on `telegram:peggy`, with the Intercom note, and the agent's `reply()` goes to Telegram.
2. A silent `⌨️` echo appears in the chat and is never delivered to the agent or shown on the surface as a reply.
3. The same `client_msg_id` twice produces one inbound and one echo.
4. Replies reach the surface only inside the window; a late message after the grace period does not.
5. Activity and the E79 status text are mirrored whoever started the turn.
6. Telegram, app and Siri behaviour is unchanged; the full suite passes.

## Stories

### S90.1 — Config and follow-target resolution — done
`adapters.intercom` schema (surfaces, follow, grace, echo, retention), tokens from env vars, surface registry, conversation-id resolution for DM and topic. Migration 044.

### S90.2 — Surface send becomes a followed-conversation inbound — done
`IntercomService.handleSend`, idempotent on `client_msg_id`, `origin: intercom` metadata, agent-visible system block, abort handling for rejected sends and bus commands.

### S90.3 — Silent Telegram echo — done
Direct adapter send with `intercom_echo` metadata; Telegram bypass of the typing loop and status draft; `echo_to_followed` flag.

### S90.4 — Interaction window and reply events — done
Window open/refresh/close with grace, `DeliveryWorker.onDelivered`, durable `reply` events (glance, plain body cut to 1,200, `more_on_telegram`), out-of-window and echo exclusion.

### S90.5 — Activity mirroring — done
`activity` (queued, running, idle, E79 status text) from the typing, tool-status and turn-ended signals for the followed conversation, snapshot on connect, stale backstop.

### S90.6 — Latency marks (I7) — done
Structured `[intercom]` log lines for `inbound_accepted`, `first_status`, `first_reply` per interaction.

### S90.7 — Glance (I3) — done
`glance` on `reply` and `send_message` (MCP and the HTTP path), truncation to 100 characters, derivation when absent, docs.

### S90.8 — Choices on the surface (M1) — not started
Choice prompts in the followed conversation render on the surface, and a tap there or on Telegram resolves both (E86 shared tap path, `choice` events).

### S90.9 — Cold-pane handling (Q4) — not started
Use the I7 data to decide whether to pin or warm the DM pane.
