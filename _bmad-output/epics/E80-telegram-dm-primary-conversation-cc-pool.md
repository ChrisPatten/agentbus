# E80 — Telegram DM as a Primary Conversation on cc-pool

| Field | Value |
|---|---|
| Epic ID | E80 |
| Dependencies | E79 (hidden `context_only` rows, `share_context`, visibility split), E69 (origin stamping, pending context), E48 (cc-pool), E65 (advisory injection stage, system blocks), E66 (journaling) |
| Story Count | 6 |
| Estimated Complexity | M |
| Status | Implemented; spike and live check on Peggy pending |

Source: operator request, 2026-10-28.

---

## Epic Summary

The operator's personal agent, Peggy, runs on `cc-pool`, and her 1:1 Telegram DM is the analogue of the Mac app's Main: one long conversation the operator comes back to all day. E69 gave Main two things: a message sent into it from elsewhere (a scheduled routine) reaches the agent as dated context on its next turn, and the agent can tell its own sends from foreign ones. E79 adds `share_context`, a hidden handoff from an interactive Claude Code session.

Both are wired to the app's Main and to `cc-headless` only. E80 makes the Telegram DM a **primary conversation** and brings both features to a cc-pool pane, so Peggy learns what her routines sent into the DM and what the operator shared from a Claude Code session, without that text appearing in Telegram.

## Problem

1. **Detection is hard-coded to the app.** `isMainConversation` (`src/app/main.ts`) matches only `channel = 'app' AND topic = 'general'`. `cc-headless.ts` (`pendingContextFor`) returns no block for any other conversation.
2. **cc-pool delivers differently.** A pane's `cc.ts` polls `GET /api/v1/messages/pending` and wakes the interactive session with a `notifications/claude/channel` event. `runBatch`, where E69 prepends the block, is not on that path.
3. **Pane sends carry the wrong origin.** `src/pool/mcp-config.ts` sets only `AGENTBUS_CONFIG`, `AGENTBUS_AGENT_ID` and the poll interval. It does not set `AGENTBUS_TURN_CONVERSATION_ID`, so every send from a pane, including its `reply` to the DM, is stamped `origin.kind = 'external'`. With pending context on, Peggy would be handed her own replies back as foreign context.
4. **A quiet DM has no session row to write into.** `resolveConversationForOutbound` returns nulls when the conversation has no active session, and `logOutboundTranscript` then skips the row. The app path avoids this with `ensureOutboundAppSession`. Telegram has no equivalent, so an E79 hidden write into a DM with no leased pane would be dropped.
5. **Topic rules can split a DM.** `topic-classify` (Stage 50) applies `pipeline.topic_rules` to non-thread topics, so a DM message matching a rule is routed to another topic, hence another conversation and another pane lease. The app avoids this for bound sessions. Peggy's config (read 2026-10-28) has no `pipeline.topic_rules` and the schema default is empty, so her DM stays in `general`. The guard still matters for any deployment that does set rules.

## Decisions

| Question | Decision |
|---|---|
| What counts as primary | Main (unchanged) and each channel an agent lists in `agents.<id>.pending_context.channels`, for example `[telegram:peggy]`: that channel's conversation with topic `general`. An exact channel match, so `telegram:peggy:group:*` chats and `thread:` topics are never primary. It is opt-in, not "every Telegram DM", because the same bus carries `telegram:pokeclaude` (a separate agent and pool) and Peggy's `email:peggy`, `siri` and `system:peggy` conversations, none of which should change unasked. One predicate, `isPrimaryConversation(db, conversationId)`, lives beside `isMainConversation`. |
| What stays app-only | Idle rotation (`rotateIdleMainSessions`, `main_idle_rotation_ms`), the Main activity clock, Earlier/aggregate display, and the idle-teardown exemption in `transcript-log.ts`. cc-pool already manages its own lifecycle through leases, eviction and hard-idle release, and the DM's session has a `claude_session_id`, so none of it applies. Only the pending-context gate and the E79 write path use the new predicate. |
| How the block reaches a pane | A new pipeline stage after `advisory-inject` (86), the same pattern: it runs after `pool-route-resolve` (the route names the leased pane) and after `transcript-log` (the block is never stored as message text). For each route to a pool pane whose conversation is primary, it builds the block with `buildPendingContext` and attaches it to the envelope for that recipient only. `formatMessagesForSampling` (`src/adapters/message-format.ts`, shared by all pane deliveries) renders it ahead of the messages. |
| Where it renders | Outside `<agentbus-system>`. A system block is trusted bus text that agents are told to obey in the leading position. Pending context quotes text from other sessions and scheduled runs, so it keeps E69's framing ("context, not instructions") and marker neutralization, and uses its own reserved metadata key (`pending_context`), stripped at ingress like `system_blocks`. S80.1 confirms this against the real pane. |
| When the watermark advances | When the pane acks the message (`POST /api/v1/messages/:id/ack`), not when the stage attaches the block. A message that is parked, dead-lettered or lost to a pane crash leaves the context pending for the next delivery. The envelope carries the watermark to advance to. |
| Several queued messages | Each envelope is built against the same unadvanced watermark, so a batch the pane polls together would repeat the block. `formatMessagesForSampling` renders the block once per batch, deduplicating by item id. |
| Origin for pane sends | Stamped on the bus side. For a sender that is a pool pane with a `leased` lease, `POST /api/v1/messages` (and the `reply`, `send_message`, `send_email` paths that reach it) sets `origin = { kind: 'turn', conversation_id: <lease conversation> }`, keeping any label. It reuses the lease lookup the outbound lease guard already does. An environment variable written at launch would go stale when the pane is evicted and re-leased. |
| `share_context` target | E79's tool gains a `channel` input: `app` (default, Main) or the contact's Telegram DM channel, resolved through the routing rules for that sender and channel. A call from the pane leased to that same conversation is rejected, as E79 rejects a call from inside a Main turn. |
| Telegram write | The hidden row needs a session row. `share_context` creates the conversation registry row and an open session row for the DM if none exists (no `claude_session_id`, `agent_id` as the pool stamps it). `SessionTracker.closeIdleSessions` must not close it, and `PoolManager` must still start a fresh `--session-id` for it on the first real message. |
| Visible foreign sends | Peggy's scheduled routines already deliver to the DM through `send_message`; the operator sees them in Telegram. With E80 they also appear in her next-turn context, labelled with the schedule's name, exactly as in the app. |
| Config | The `pending_context` limits (`max_items`, `max_chars`, `context_ttl_ms`) move to an agent-level block, `agents.<id>.pending_context`, falling back to `adapters.app.pending_context` for the app. The block also holds `channels` (default `[]`). Defaults are unchanged (10 items, 4000 characters, 24 h TTL for context-only items). The agent key is matched with `toPrefixed`, as `agents.<id>.memory` is, so Peggy's existing `"agent:peggy"` entry works. |
| Reply targeting | The app marks "the user is replying to this one" through `quoted_message`. Telegram native replies are not mapped in v1. |
| Rotation | Not added. cc-pool's lease lifecycle and journaling triggers stand in for it. |

## Exit Criteria

1. With the Telegram DM as the only change, a scheduled routine's `send_message` into the DM shows up in Telegram as it does today and appears in Peggy's next DM turn as dated context, labelled with the schedule's name.
2. From a Claude Code session, `share_context(channel=<Telegram DM>, source=…, body=…)` shows nothing in Telegram. Peggy's next DM turn receives the note in the "context shared with you (the user has not seen these)" section, whether or not a pane was leased when it was shared.
3. Peggy's own replies and proactive sends from the DM pane are never injected back. A send from a pane leased to another conversation (a scheduled-topic pane messaging the DM) is.
4. Context survives pane eviction, hard-idle release and a bus restart, and a message that never reaches the pane (parked, dead-lettered) leaves it pending. A note shared more than 24 hours ago is skipped.
5. A DM with no prior session accepts `share_context`; its first real message launches a fresh pane session, not a resume.
6. Several messages polled together carry one block. `topic_rules` do not cause primary-conversation context to go missing (S80.1 settles how).
7. Main and `cc-headless` behavior is unchanged; E69 and E79 tests still pass.
8. Docs (`docs/CC_POOL_ADAPTER.md`, `docs/MCP_TOOLS.md`, `docs/HTTP_API.md`, `docs/APP_PROACTIVE_DELIVERY.md`, `docs/CC_HEADLESS_ADAPTER.md`), the cc-pool and Telegram pages under `site-docs/`, `CHANGELOG.md`, and the Peggy `CLAUDE.md` wording are updated.

## Stories

### S80.1 — Spike: confirm the cc-pool assumptions

Settle, with the real binary and a test pool on `baxter-mac-test` (or Peggy's pool with the operator's go-ahead), what the rest of the epic builds on. Record findings in this file.

- **Rendering.** A pane's `<channel>` turn shows leading text attached to the envelope (a throwaway reserved key through `formatMessagesForSampling`). Confirm where it lands, that the model reads it, and that it survives `--resume`.
- **Hook route.** Does `UserPromptSubmit` fire on a channel-injected turn? E73 S73.1 left this unverified for panes. Only record the answer; the stage route does not depend on it.
- **Naming.** Confirm in Peggy's `conversation_registry` that the DM is channel `telegram:peggy`, topic `general`. From her config the routes match `telegram:peggy`, which also matches `telegram:peggy:group:*` (`channelMatches`), so the primary check must be an exact channel match.
- **Topic rules.** Resolved for Peggy: her config has none. Keep a test that a deployment with `topic_rules` doesn't lose primary-conversation context; if one does, exempt the primary channel from classification and add that to this epic.
- **Session placeholder.** What `PoolManager` does when the conversation's only session row has no `claude_session_id`, and what stamps `sessions.agent_id` for a pool conversation.

### S80.2 — Primary-conversation predicate and config

- `isPrimaryConversation(db, conversationId, config)` in `src/app/main.ts` (or a neutral module), covering Main and the conversations on each agent's configured `pending_context.channels` (exact channel, topic `general`). Use it only at the pending-context gate (`pendingContextFor`) and in the E79 write path; the three `isMainConversation` call sites for rotation and teardown are left alone.
- Add `agents.<id>.pending_context` with fallback to `adapters.app.pending_context`; update `pendingContextLimits` and the schema and example config.
- Tests: predicate for Main, a listed DM, an unlisted DM (`telegram:pokeclaude` when only `telegram:peggy` is listed), a group, a forum thread, other contact; config fallback and override; `"agent:peggy"` and `peggy` keys both resolve.

### S80.3 — Bus-side origin for pane sends

- In `POST /api/v1/messages`, for a sender whose agent id is a pool pane with a `leased` lease, replace `metadata.origin` with `{ kind: 'turn', agent_id, conversation_id: <lease conversation>, label? }`, keeping a caller-supplied label. No lease, a `free`/`dead` lease, or a non-pane sender leaves origin as today.
- Cover the `reply`, `send_message` and `send_email` paths. `cc-headless` is unchanged, since its MCP child already sets the turn variable.
- Tests: pane reply to its own conversation (own), pane send to a different conversation (foreign to the target), stale lease, spoofed `origin` replaced, label preserved.

### S80.4 — Pending-context stage for pool panes

- New stage at slot 87, `critical: false`. For each `cc-pool` route resolved to a pane whose conversation is primary, call `buildPendingContext` with the envelope id as the batch, attach the block under reserved key `pending_context` for that recipient, and record the watermark to advance to. Skip slash commands, system-only and journaling envelopes, as `advisory-inject` does.
- Add `pending_context` to the reserved keys stripped at ingress.
- `formatMessagesForSampling` renders the block once per batch (dedupe by item id), ahead of the first message and outside any `<agentbus-system>` tag, with marker neutralization.
- Advance the watermark in the ack handler when the acked message carries one. A parked message re-enqueued by `drainParked` keeps its attachment or has it rebuilt; either way nothing advances early.
- Tests: injection for a leased pane, none for a non-primary conversation, none for a pane's own sends, watermark advances on ack only, a dead-lettered message leaves context pending, batch dedupe, TTL and budget honored.

### S80.5 — `share_context` for the Telegram DM

- Extend E79's route and tool with `channel` (default `app`). Resolve the target conversation and owning agent through the pipeline routes for the contact and channel; reject unknown or non-primary targets.
- Add `ensurePrimarySession` for the Telegram DM: create the conversation registry row and an open session row when missing, with the guarantees in the Decisions table (not closed by `SessionTracker`, first message starts a fresh pane session).
- Reject a call from the pane leased to the target conversation.
- **Reaching a remote bus.** Peggy's bus runs on BobaFett, but `src/adapters/cc.ts` builds `busBaseUrl` as `http://127.0.0.1:<http_port>`, so a Claude Code session on another machine can't call `share_context` (or any MCP tool) against it. Add an `AGENTBUS_URL` override to the tools-only MCP server, the same variable the hooks already use, and send the bus token with it (check how `bus-auth.ts` is applied there). Until then the workaround is an SSH tunnel to a free local port with a small config whose `http_port` matches, or running the Claude Code session on BobaFett.
- Make sure E79's `context_only` filter also hides the row from Telegram-side reads: transcript API, search, journaling window rendering as in E79 S79.5.
- Tests: write to a DM with no session, with an open session, with a leased pane; hidden from transcript reads; first inbound launches a fresh `--session-id`; own-pane rejection.

### S80.6 — Docs, Peggy instruction and live check

- Update the docs and `site-docs/` pages listed in exit criterion 8, `CHANGELOG.md`, and run `npm run docs:build`.
- Provide the Peggy `CLAUDE.md` wording for the Claude Code side, adapted from E79's, with `channel` set to her Telegram DM.
- Live check on Peggy (with the operator): a scheduled routine message into the DM and a reply to it; `share_context` from a Claude Code session with no pane leased; the same with the pane leased and busy; an eviction and `/clear` in between; confirm Telegram shows no shared note, Peggy's replies are not re-injected, and a dead-lettered message leaves the context for the next one.

## Findings (code reading)

S80.1 needs the real `claude` binary and Peggy's pool, which was not available when E80 was built. These are the answers code reading settles; everything else is listed under **Still unverified** and needs the live spike.

**Naming.** A Telegram DM envelope's channel is the adapter id: `telegram:<instance>` for a named bot (`telegram:peggy`), plain `telegram` for the single-bot form (`TelegramAdapter` sets `this.id`, and `processUpdate` uses it for a private chat and `${id}:group:<chatId>` for a group). `normalize` fills the missing topic with `general`, so a DM is the conversation `computeConversationId(contact, 'telegram:peggy', 'general')` and `transcript-log` upserts `conversation_registry(channel='telegram:peggy', topic='general')`. A forum topic gets a `thread:<hash>` topic and a group gets the `:group:` channel. Routes use `channelMatches`, so `match.channel: telegram:peggy` also matches `telegram:peggy:group:*`; `isPrimaryConversation` therefore compares the registry row's channel exactly. Peggy's real registry row was not read; the names above follow from the code and her routes.

**Topic rules.** Stage 50 does move a DM message to another topic (and so another conversation and lease) when a `pipeline.topic_rules` rule matches. Peggy has none, but a deployment that did would lose the primary conversation's context. As this epic anticipated, a listed primary channel is now exempt from the rules (`createTopicClassify`), with a test; thread topics and unlisted channels are classified as before.

**Session placeholder.** `PoolManager.resolveRoute` takes the conversation's newest open session as `priorRow` (`getActiveSessionRow`, `ended_at IS NULL`) and calls `pickSession(priorRow?.claude_session_id ?? null)`: a null id returns a fresh `randomUUID()` with `resume: false`, so the pane launches with `--session-id`, never `--resume`. `persistSessionId` then writes the new id onto that same row, so the placeholder row is reused and not duplicated. By the time `transcript-log` runs, the row has a `claude_session_id`, which also keeps the stage's "gap longer than the idle threshold, no Claude session: end the old session and start a new one" branch from firing. If the pool is exhausted the message parks before `persistSessionId`, the row keeps a null id, and `transcript-log` ends the placeholder and inserts a new row (harmless: it has no messages). `SessionTracker.closeIdleSessions` closes any open row with `claude_session_id IS NULL` past the idle threshold, so it now skips a message-less row in a listed channel.

**What stamps `sessions.agent_id` for a pool conversation.** `transcript-log` stamps it at row creation from the first cc-headless or cc-pool route's `recipientId`, after `pool-route-resolve` rewrote it: the concrete pane id (`agent:peggy-pool-3`), or the parked-bucket id when the message parked. It is not updated when the row is extended or the conversation moves to another pane. `JournalEngine.agentForSession` resolves a pane id, the pool's logical id or a bucket id through `RuntimeResolver` to the logical agent, so the placeholder is stamped with the pool's logical id (`agent:peggy`, the route target's `recipientId`).

**Ack and metadata.** A pane's `cc.ts` acks each message with `POST /api/v1/messages/:id/ack` as soon as it dequeues it, before it sends the channel event. A message stays in `message_queue` with its metadata while `processing` (only `deadLetter` and the expiry sweep delete rows; `ack` sets `delivered` and keeps the row), so the handler can read the attachment with `queue.getById(id)` before `queue.ack(id)` and advance the watermark on success. No side table was needed. `drainParked` acks the parked row through the queue object (not the route) and re-enqueues `{ ...envelope, id: new, recipient }`, which copies the metadata including the attachment, so a parked message keeps its block and nothing advances early.

**Baseline for a pane.** E69's no-watermark baseline is the newest inbound row before the batch. For a pane that is wrong in one case the spec cares about: a first message that was dead-lettered still has an inbound transcript row, so the next message's baseline would sit after the context shared before it and the context would be lost. The stage therefore asks for a delivered baseline (`deliveredBaseline`): the newest inbound row whose queue row is `delivered`.

**Deviations from the spec text.** (1) The stage is slot 88, not 87: 87 is already `journal-hold`. (2) `formatMessagesForSampling` renders the block of the attachment with the newest watermark per conversation, which covers the older ones built against the same unadvanced watermark; it does not union item lists. (3) The ack advances to the acked message's own mark, so when a batch's later message is dead-lettered after an earlier one is acked, items between the two marks that were shown with the batch are shown again next time. (4) The block's relative ages are fixed when the message is received, so a message that waited in the park queue shows the ages from then (absolute datetimes are right). (5) The placeholder is stamped with the pool's logical agent id, not a pane id, since no pane exists.

**Changes from review.** (6) Pane sends get their schedule label bus side: `paneTurnOrigin` uses `scheduleLabelFromMetadata` (shared with cc-headless's `scheduleSourceLabel`) when the newest inbound message of the pane's conversation is a scheduled fire, so exit criterion 1's "labelled with the schedule's name" holds; a caller `source` still wins. (7) A `reply` names its conversation (`metadata.conversation_id`), and that wins over the lease in any lease state, so a late reply from an evicted pane is its conversation's own turn; without a conversation id only a `leased` lease counts, and the stale-pane 409 is unchanged. (8) `DeliveryWorker` logs a send into a listed channel's `general` conversation (`primaryChannels`), not the newest registry row for the contact and channel; a send into a DM with no open session is still not logged (existing `resolveConversationForOutbound` behavior, a known gap). (9) With `AGENTBUS_URL` set, `cc.ts` sends only the environment's token (`AGENTBUS_BUS_TOKEN`, `AGENTBUS_TOKEN`, then `AGENTBUS_TOKEN_FILE`, the hooks' convention), never the local config's `bus.auth_token`. (10) `share_context` for a Telegram channel needs a configured bot and a contact with `platforms.telegram`, the adapter's own rule for a contact being the bot's.

**Known and unchanged.** The delivered baseline can still lose context in one narrow case: a first message that was parked and later dead-lettered, with no watermark yet. `cc.ts` acks on dequeue, before the channel event reaches Claude, so a crash after the ack loses that delivery's context. `POST /api/v1/context` is unauthenticated on a bus with no `bus.auth_token` (a documented prerequisite). A retried `share_context` call duplicates the note, and rows written in the same millisecond order by row id. Observed while testing: `sessions.claude_session_id` stays NULL for a conversation's rows after its first two pool messages (the TODO in `PoolManager.persistSessionId`), so an evicted conversation's next launch is fresh, not a resume; pre-existing, for the live spike.

**Still unverified (needs the live spike).**
- Where a pane's `<channel>` turn shows the leading block, that the model reads it, and that it survives `--resume`.
- Whether `UserPromptSubmit` fires on a channel-injected turn (the stage route does not depend on it).
- What `/clear` and resume do to context injected before the clear (the E73 spike saw `/clear` start a new Claude session id): the live check covers it, and the journal already carries what matters.
- Peggy's actual `conversation_registry` row for the DM, and `sessions.agent_id` on her existing rows.
- The first real message after a placeholder on the real pool (the unit test covers `resolveRoute` with a fake launcher only).

## Risks

- **Topic rules.** Not a risk for Peggy's current config (none set). Other deployments with `topic_rules` are covered by the S80.1 test and its fallback.
- **Stage ordering and ack.** The watermark depends on the ack path carrying the message's metadata; if acks don't expose it, S80.4 stores the target in a small table keyed by message id instead.
- **`/clear` and resume.** A pane cleared on eviction resumes from the conversation's stored session id. If a clear starts a new Claude session id (as the E73 spike observed for `/clear`), context injected before the clear lives only in the old transcript. The live check covers this; the journal already carries what matters.
- **Pool launch cost.** None added: no hidden write or injection starts a pane.

## Deployment Notes (Peggy)

From Peggy's `agentbus-config.yaml` on BobaFett, read 2026-10-28:

- **Separate deployment.** Her bus (`~/.agentbus_data/agentbus.db`, port 3000) is not the local `baxter-mac-test` bus. E79 and E80 reach her only by deploying a build that has them there, then adding `agents."agent:peggy".pending_context.channels: [telegram:peggy]`.
- **Pool shape.** `peggy-pool` is 3 fixed panes growing to 8, `idle_evict_ms` 30 min, `hard_idle_ms` 6 h, `on_evict: clear`. The DM, `system:peggy` and Siri are the consistently active conversations, so a pending-context stage and an eviction-then-resume path both matter in daily use.
- **Foreign senders.** Her routines run in `system:peggy` conversations and send into `telegram:peggy`, which is exactly the foreign case E69 and S80.3 cover.
- **`context:user` route.** `pipeline.routes` sends a `context:user` channel to her pool. The operator confirmed it is an abandoned proof of concept, so it plays no part in this epic. The route can be removed from her config as cleanup.
- **Unauthenticated, LAN-bound bus.** `bus.host` is `0.0.0.0` and no `bus.auth_token` is set, and the schema comment advises setting one in that case. Anything that can reach port 3000 can already post messages. Setting a token is a prerequisite for pointing remote Claude Code sessions at it.
- **PokeClaude.** `telegram:pokeclaude` has its own pool and is unaffected unless its channel is listed.

## Out of Scope

- Telegram groups, forum topics, email and other channels.
- Mapping Telegram native replies to pending-context items.
- Idle rotation for the DM's Claude session.
- A hook-based delivery path (`UserPromptSubmit`); S80.1 only records whether it works.
- Waking Peggy or starting a pane for a shared note.
- An audit view of hidden context (E79 decision).
