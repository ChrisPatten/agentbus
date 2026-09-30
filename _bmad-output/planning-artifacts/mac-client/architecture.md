# Mac Client — E58/E59 Architecture Decisions

**Status:** In implementation · **Date:** 2026-09-30 · **Sources:** `product-brief.md` v0.4, `PRD.md` v0.1, E58 and E59 epics

This records the integration contract for the two foundation epics. E60's bound-session and Earlier-resume mechanics remain a separate design gate.

## 1. Headless scheduling and activity (E58)

- A conversation ID owns serialization. At most one child process runs for a conversation, including after an early `reply` tool call. Delivery may be acknowledged before process exit, but the next turn for that conversation cannot spawn until both delivery handling and child exit settle.
- Each `HeadlessInstance` owns one capacity limiter. Default total capacity is five children, of which one slot is reserved from user turns for system turns. System turns may use any free slot. A mixed system/user batch is a user turn. Choose the oldest waiting turn that is eligible under the current counts.
- A limiter slot represents a live `claude -p` child and is released on its exit, including crash and stop paths. A cancelled waiter leaves the waiting set without consuming capacity.
- Journaling uses an agent-scoped lane as well as the conversation queue. This prevents two journal turns for one agent from overlapping while allowing unrelated user turns to proceed.
- The headless runtime exports an optional activity subscription and snapshot, keyed by agent and conversation, with session ID when known. States are `queued`, `running`, and `idle`; counts include running user, running system, and waiting. The app adapter can consume these without requiring Telegram or other adapters to implement activity.

## 2. App transport and identity (E59)

- Use `@fastify/websocket` on the existing Fastify listener. The app adapter binds no new port. The socket and every `/api/v1/app/*` route resolve `Authorization: Bearer <token>` to exactly one contact; the existing `X-Bus-Token` requirement remains in force when configured. Tokens stay in headers and out of logs.
- Protocol v1 uses typed JSON frames. Client frames: `hello`, `send`, `create_session`, `rename_session`, `mark_read`, `ping`. Server frames: `welcome`, `ack`, `event`, `error`, `pong`. `welcome` carries the protocol version, reset flag, and latest cursor. `event` carries a per-contact `seq`, event kind, and data. `send` has stable `client_msg_id`; retries return the original ack.
- A dedicated SQLite `app_events` log supplies a strictly increasing per-contact sequence. Transcript inserts feed `message` events from the shared transcript paths, so Telegram/email/Siri messages are mirrored without calling their adapter `send()` methods. Session lifecycle/title changes feed `session` events. The transcript or session write and event creation share one SQLite transaction, or an equivalent trigger on that same write.
- Each socket uses one cursor-based drain for both catch-up and live delivery. On `hello`, the server reads committed events after the supplied cursor; a bounded 100 ms pump continues the same drain while the socket is open. Each drain captures a committed high-water mark, emits visible rows through that mark in order, then advances its scan cursor. The next drain catches later commits, so there is no separate replay/live handoff gap. Ordering and duplicate suppression use `seq`. Events remain durable across bus restart; an expired cursor causes `welcome.reset` and a full session/history reload.
- Visibility is checked against authenticated contact and the app route's agent when serving lists, history, and events. A guessed session ID must not disclose another contact's or agent's transcript. Scheduler and journaling sessions remain hidden.
- A first proactive app send must create or resolve the `app`/`general` Main conversation before outbound transcript logging. Topic-directed outbound sends must resolve by topic/session, because the existing outbound helper chooses the most recent conversation for a contact and channel, which is insufficient for multiple app topics.
- `AppAdapter.send()` persists the app outbound transcript and event before returning success. `DeliveryWorker` may acknowledge that queue item only afterward and must avoid writing a duplicate transcript. The usual post-ack best-effort transcript path is insufficient for an offline app message because a crash between ack and logging would lose the only client-visible record.
- A client `send` first stores a durable intent keyed by contact and `client_msg_id`, including its stable message ID, route, body, and attachments. Creating a new app topic and storing that intent commit together. On startup and retry, a pending intent is reconciled against the queue and inbound transcript: preserve an existing queue entry; enqueue the stored envelope when the transcript exists but the queue entry does not; otherwise retry the pipeline with the stable ID. A command response is correlated to its source message ID; an uncertain command outcome is reported as ambiguous rather than rerun after its inbound transcript exists. Persist the final acknowledgment before sending it to the socket.
- Session and transcript pagination use a stable row ID as the tie breaker when timestamps match. Clients pass the returned row cursor as `before`.
- The existing Fastify multipart registration has a zero-file default for the Pebble webhook. The app upload route must set a route-specific file allowance and byte limit while keeping Pebble's zero-file behavior.

## 3. Ownership and handoff

- E58 owns `cc-headless` scheduling, configuration limits, stop behavior, and activity snapshot/subscription exports.
- E59 owns the app adapter, app HTTP/socket routes, event storage, contact token configuration, and protocol client script. Shared `schema.ts`, `api.ts`, and `index.ts` edits are sequenced after the E58 exports are stable.
- E60 will own `metadata.bound_session_id`, owner routing, foreign-session continuation, and Earlier resume. E59 must keep session, conversation, owning agent, and arrival channel separate in its API model, and reject unsupported foreign/Earlier sends clearly until E60 lands.

## 4. Verification gates

- E58: four user processes plus one system process, fifth user queued; no two turns in one conversation overlap; stop is scoped; journaling lane holds.
- E59: invalid token fails before enqueue; idempotent retry survives restart; event replay works across disconnect and restart; a no-client app send still yields a Main transcript/event; a Telegram outbound transcript appears in the app; app uploads obey media and size limits.
- Integration: activity events from E58 reach an app socket and are snapshotted on reconnect. Run the full bus suite and type check after merging both work streams.
