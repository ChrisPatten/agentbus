# E76 — Slack Channel via n8n Relay

| Field | Value |
|---|---|
| Epic ID | E76 |
| Status | In progress — S76.0 POC shipped and live-checked 2026-10-21 (on feat/e76-slack-outbound-poc, not yet merged to dev); S76.0b onward not started |
| Dependencies | E5 (inbound pipeline), E27 (generic thread store), E25 (webhook identity pattern, for comparison) |
| Story Count | 8 (S76.0 POC, S76.0b rename, + 6) |
| Estimated Complexity | M |

Source: operator request, 2026-10-20.

## Epic Summary

Add a two-way `slack` channel without building a hosted Slack app. A self-hosted n8n instance does all the Slack I/O: it receives Slack events, holds incoming messages in a queue, and posts replies. AgentBus runs on a laptop that is often offline or asleep, so it never takes inbound connections. It polls n8n for queued messages, acks them once they're enqueued, and calls n8n to send replies. Messages sent while the laptop is offline wait in n8n and are delivered in order when AgentBus comes back.

## Problems

1. **No Slack channel.** The operator can reach agents from Telegram, email, Siri, and the Mac app, but not from Slack, where much of the workday happens.
2. **No public ingress.** AgentBus runs on a laptop behind NAT. Slack's Events API needs a public HTTPS endpoint that is always up. The laptop is neither.
3. **Offline gaps.** A push-only design would lose messages, or depend on Slack's retries (3 attempts, then dropped), whenever the laptop is asleep.
4. **Full Slack app overhead.** A Bolt service, OAuth distribution, and hosting are far more than one person's own workspace needs.

## Design Decisions

| Decision | Choice |
|---|---|
| Naming | The transport is **`slack-n8n`**, not `slack`, so a future native Slack connector can take `slack` without a migration. That covers the channel name (which feeds `conversation_id` and transcripts), adapter id, config block `adapters.slack-n8n`, source files, and docs pages. The contact identity stays `contacts.<id>.platforms.slack.user_id`: a Slack member id is the same whichever transport delivers the message, so a native connector would reuse it. Done in S76.0b, before anything stores conversations on the channel. |
| Slack side | A minimal **internal** Slack app, used only for its bot token and Event Subscriptions. No hosted code: Event Subscriptions point at an n8n webhook. A manifest is checked in so the app takes about 5 minutes to create. Every Slack API path needs a token from some app; "no full-blown app" means no server, no distribution, and no slash commands. |
| Slack surface | The bot's DM (Messages tab) by default. A dedicated private channel (e.g. `#agentbus`) is supported through config. Scopes: `chat:write`, `im:history`, `reactions:write`, plus `groups:history` / `channels:history` if a channel is used. |
| Ingest mode | **Events** only (Slack Trigger node, `message.im`). n8n is reachable from the internet. Polling `conversations.history` was rejected: it returns only top-level messages, so replies you send inside a thread, which is where the agent answers, would be missed. |
| Queue | An n8n **Data Table** `agentbus_inbox`. Self-hosted n8n has unlimited executions, so frequent polling costs nothing. Static workflow data is not used because it is unsafe under concurrent executions. |
| Queue row | `{msg_id: "<channel>:<ts>", channel, ts, thread_ts, user, text, status, received_at, delivered_at}`. `status` is `pending` → `delivered`. `ts` is stored as a string to keep its full precision. |
| Relay contract | Three JWT-authenticated n8n webhooks under one base URL (`relay_url`, e.g. `https://n8n.example.com/webhook`). `GET /agentbus/inbox?limit=N` returns `{messages: [...]}`, pending rows oldest-first. `POST /agentbus/ack {ids}` (never empty) marks rows delivered and returns `{ok, acked}`. `POST /agentbus/send {slack_user_id | channel, thread_ts?, text}` grows out of the S76.0 webhook and returns `{ok, ts}`, `403` for a channel not on the allowlist, and `502` for a Slack failure. Setup: `integrations/n8n/slack-relay/README.md`. |
| Delivery semantics | At-least-once from n8n. There are no leases: AgentBus is the only consumer and polls one page at a time, so a row stays `pending` and is returned again until it is acked. AgentBus is exactly-once through a local `slack_relay_seen` table keyed by queue row `id`, checked before `processInbound()`. The pipeline's dedup stage is time-window based (`dedup_window_ms`, 30s) and wouldn't catch a backlog redelivered hours later. |
| Poll cadence | Adaptive: `active_ms` (default 5000) for 2 minutes after any traffic, then `idle_ms` (default 30000). Polls immediately on start and after a gap longer than 2× `idle_ms` (wake from sleep). Drains in pages until `/inbox` returns fewer than `limit` rows. |
| Identity | `contacts.<id>.platforms.slack.user_id` (Slack `U…` id) resolves to `contact:<id>`. n8n filters to an allowlist of user ids too. AgentBus drops any row whose user maps to no contact, logs a warning, and still acks it so it isn't redelivered forever. |
| Threading | Thread key `${channel}:${thread_ts ?? ts}` through the generic thread store (`src/pipeline/thread-store.ts`). Each Slack thread is its own session. A top-level message starts a thread. `send()` replies with that `thread_ts`, so the conversation stays in the thread. Metadata stores `{channel, threadTs}`. |
| Outbound when n8n is down | `send()` returns `retryable: true` on network errors and 5xx. `DeliveryWorker` keeps the reply queued in AgentBus and retries it. |
| Receipts | n8n reacts ⏳ when a message is queued and swaps it for 👀 on ack. AgentBus leaves the reactions to n8n, so you can tell "queued, laptop offline" from "picked up". ✅ on reply is S76.5. |
| Formatting | Markdown in replies is converted to Slack mrkdwn (bold, italics, links, code, lists). Replies longer than `max_message_length` (default 3900) are split on paragraph boundaries. |
| Security | HS256 JWTs on every relay webhook, using n8n's Webhook **JWT Auth** (S76.0). AgentBus signs a fresh token per request (`iss: agentbus`, `exp` 60s, `jti` = bus message id) with a shared passphrase, and n8n verifies it. n8n's `/send` rejects any channel not on its allowlist, so a leaked secret can only post where the bot already talks. The secret is in plaintext in `config.yaml`, consistent with other adapter secrets. |
| Retention | n8n deletes `delivered` rows after 7 days through a daily cleanup workflow. AgentBus prunes `slack_relay_seen` rows older than 30 days. |
| Out of scope (v1) | Typing indicators, tool-status streams, interactive approvals, attachments, edits and deletes of Slack messages, multiple workspaces. |

## Exit Criteria

1. A DM to the bot while AgentBus is running reaches the routed agent within about 5s, and the agent's reply appears in the same Slack thread.
2. Messages sent while AgentBus is stopped show ⏳ in Slack and are all delivered in order on the next start, each exactly once.
3. Killing AgentBus between `/inbox` and `/ack` causes redelivery on the next poll, and the seen table suppresses the duplicate.
4. A reply sent while n8n is unreachable is delivered once n8n comes back.
5. A message from a Slack user not mapped to a contact is dropped and logged, and never reaches an agent.
6. Two Slack threads map to two separate sessions.
7. Tests, `docs/SLACK_ADAPTER.md`, `docs/HTTP_API.md` (if touched), `site-docs/` channel page, `config.yaml.example`, and `CHANGELOG.md` are updated. The full suite, `tsc`, and `npm run docs:build` pass.

## Stories

### S76.0 — POC: outbound DM through an n8n webhook

The smallest end-to-end slice: AgentBus sends a Slack DM through one n8n webhook. No inbound, queue, threads, receipts, or formatting.

- Contract: `POST <webhook_url>` with `Authorization: Bearer <JWT>` and body `{slack_user_id, message}`. `200 {ok, ts}` is delivered. `400`, `401`, and `403` fail without retrying. `429`, `5xx`, timeouts, and network errors retry through `DeliveryWorker`.
- JWT: HS256 signed with `node:crypto` (no new dependency). Claims `iss: "agentbus"`, `iat`, `exp` (`jwt_ttl_seconds`, default 60), `jti` (bus message id). The secret is used as raw UTF-8 bytes, matching n8n's Passphrase key type.
- Config: `adapters.slack: {enabled, webhook_url, jwt_secret (≥32 chars), jwt_ttl_seconds, request_timeout_ms}` and `contacts.<id>.platforms.slack.user_id`, validated as a Slack id and unique across contacts.
- `src/adapters/slack.ts` (`channels: ['slack']`, `send` only) and `src/adapters/slack-jwt.ts`, registered in `src/index.ts`. The agent sends with `send_message({to: "contact:<id>", channel: "slack", body})`.
- n8n: Webhook (JWT Auth) → validate → Slack Send to User → Respond. Setup in `integrations/n8n/slack-relay/README.md`.
- Tests: signer, adapter against a fake HTTP server (body, token, status mapping, timeout, missing Slack id), config schema.
- Docs: `docs/SLACK_ADAPTER.md`, `site-docs/` channel page, `CHANGELOG.md`, `config.yaml.example`.
- Exit: `send_message` to the operator delivers a DM from the bot (live check, operator's step).


### S76.0b — Rename the transport to `slack-n8n` (do first)

Operator request, 2026-10-21. The S76.0 POC shipped as `slack`. Rename it before inbound work starts, while the only stored data is outbound transcript rows without a conversation.

- Channel and adapter id `slack` → `slack-n8n`. `send_message(channel: "slack-n8n")`.
- Config `adapters.slack` → `adapters.slack-n8n` (`SlackN8nAdapterSchema`). The loader rejects the old `adapters.slack` key with an error naming the new one, rather than silently ignoring it. Pre-1.0 and unreleased, so no alias.
- Keep `contacts.<id>.platforms.slack.user_id` unchanged.
- Files: `src/adapters/slack.ts` → `slack-n8n.ts` (class `SlackN8nAdapter`), `slack-jwt.ts` → `slack-n8n-jwt.ts`, tests and `src/config/slack-schema.test.ts` to match. Log prefix `[slack-n8n]`.
- Docs: `docs/SLACK_ADAPTER.md` → `docs/SLACK_N8N_ADAPTER.md`, `site-docs/channels/slack.md` → `slack-n8n.md` (sidebar label "Slack (via n8n)"), configuration reference, `config.yaml.example`, `docs/README.md`, CHANGELOG entry reworded.
- The n8n webhook path and payload don't change. The operator's live `config.yaml` needs the block renamed (operator's step, noted in the release notes).
- Leftover transcript rows with `channel = slack` from the POC are left as they are.

### S76.1 — n8n workflows and Slack app manifest

Check in under `integrations/n8n/slack-relay/`:

- `slack-app-manifest.yaml`: bot user, scopes, the `message.im` event (plus channel events, commented out), Event Subscriptions URL placeholder.
- Workflow exports (JSON): `ingest`, `inbox`, `ack`, `send`, `cleanup`. Credentials are referenced by name, never embedded.
- `ingest`: ignore `bot_id`, `subtype` (edits, joins), and users not on the allowlist. Insert the row with an idempotent `id` so Slack event retries don't double-insert. React ⏳.
- `inbox`: header auth, select pending rows, sort by `ts`, return JSON.
- `ack`: header auth, set `delivered`, swap ⏳ for 👀.
- `send`: header auth, check the channel allowlist, `chat.postMessage`, return `ts`. Map Slack's `ratelimited` error to HTTP 429 with `Retry-After`.
- A README with the setup steps and a `curl` test for each webhook.

### S76.2 — Configuration

- `adapters.slack`: `enabled`, `relay_url`, `relay_token` (≥ 16 chars), `poll.active_ms`, `poll.idle_ms`, `poll.limit` (default 50), `max_message_length`, `request_timeout_ms`.
- `contacts.<id>.platforms.slack.user_id`, validated as a Slack user id. Two contacts may not share one.
- `config.yaml.example` entry and a route example.

### S76.3 — Adapter: poll, enqueue, ack

- `src/adapters/slack.ts`: `SlackRelayAdapter implements AdapterInstance`, `channels: ['slack']`.
- Poll loop with the adaptive cadence and wake detection. One poll in flight at a time. `stop()` waits for the current page.
- Per row: seen-check → contact resolve → `processInbound()` → record seen. Ack the page after all rows are processed. Rows that fail with a non-retryable error are recorded and acked. A retryable failure stops the page without acking, so the next poll returns it again.
- Migration `036_slack_relay_seen.sql` and pruning.
- `health()`: last successful poll, consecutive failures, and the backlog size on the last drain. `degraded` after 3 failed polls in a row.

### S76.4 — Threading and `send()`

- Thread key derivation and thread-store writes on inbound.
- `send()`: look up `{channel, threadTs}` from the thread store by topic. Fall back to the contact's DM channel for a proactive message with no thread (stored per contact on first inbound).
- Map `/send` results to `DeliveryResult` (`platformMessageId` = Slack `ts`; network and 5xx errors are retryable; 4xx is not, except 429).

### S76.5 — Formatting and receipts

- Markdown → mrkdwn converter with tests. Paragraph-aware splitting. Each chunk posts in the same thread.
- Optional `POST /react {channel, ts, emoji}` webhook so AgentBus can add ✅ to the inbound message once the reply is delivered. Declares `react: true`.

### S76.6 — Docs, tests, live check

- Unit tests with a fake relay server: drain, redelivery before ack, seen suppression, unknown user, retryable send, thread mapping.
- `docs/SLACK_ADAPTER.md` (architecture, relay contract, semantics, security) and the `site-docs/` channel page (setup walkthrough: create the app from the manifest, import the workflows, configure AgentBus).
- `CHANGELOG.md` under `[Unreleased]` → Added.
- Live check against the operator's workspace for exit criteria 1–4 (the operator's step).

## Open Questions

1. **Credential type.** Connecting n8n to Slack is approved (operator, 2026-10-20). The S76.0 POC runs on the operator's own user credential, so DMs arrive from the operator's account. A formal bot is in progress. The inbound stories (S76.1, S76.3) need it, because with a user token the agent's replies look like the operator's own messages and the ingest filter can't tell them apart.
2. **Channel scope.** DM only for v1, or a private channel too?
3. **Approvals over Slack.** A follow-up could answer E51/E74 approval requests with a threaded `approve` / `deny` reply. That's a separate epic.
