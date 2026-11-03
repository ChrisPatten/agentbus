# E96 — Surface API v2: surfaces, devices and the Compact data model

| Field | Value |
|---|---|
| Epic ID | E96 |
| Dependencies | E89 (notifications), E90 (follow engine), E91 (intercom surface, WS protocol v1), E93 (web prototype), E94 (desk mode, summary payload; note: the E94 label was reused for desk mode while the backlog reserves E94 for wake word) |
| Story Count | 8 |
| Estimated Complexity | L |
| Status | Scoped, not started |

Design source: `peggy-claude-code/data/intercom/architecture.md` (v0.1, revised Nov 3, 2026) and `data/intercom/taxonomy.md`. Requested by Chris, Nov 3, 2026. This epic is phase 1 of the architecture: the bus side only. The web client and firmware are separate epics.

---

## Epic Summary

Today an Intercom "surface" is a configured entry with one static bearer token, shared by every device paired to it, served on the single localhost-bound HTTP port, with one calendar payload, one desk summary and a handful of events. That works for one iPhone. It cannot support what Chris has described: several devices (up to about 10) consuming what an agent publishes, the Compact reaching the bus over the LAN and a phone relay, agent-created Events with action buttons, slot overrides, widgets, a Conversation view, and agents flagging "answer needed".

This epic splits the model into **surfaces** (what an agent publishes to) and **devices** (what consumes a surface), adds a revisioned resource model with delta push and an action path, adds a separate TLS listener for the LAN, and gives agents the tools to publish. Existing `/api/v1/intercom` behaviour keeps working as an alias.

## Verified Behavior

Checked Nov 3, 2026 against the checkout (agentbus dev @ 0711726):
- `docs/INTERCOM.md` documents WS protocol v1 (`hello` with `cursor`, `welcome` with `latest_seq` and `reset`, durable events with per-surface `seq`, replay after cursor), HTTP `/health`, `/today`, `/desk`, `POST /pair`. Notifications (E89) carry actions and `notification_action` frames exist.
- `src/config/schema.ts` already has `bus.host` (default `127.0.0.1`) and `http_port` (default 3000); it warns about LAN exposure. One listener serves everything today.
- `src/scheduler/scheduler.ts`: scheduled items (`once`/`cron`) fire by injecting a message into the inbound pipeline "as if the configured contact sent it". There is no action trigger.
- `reply`/`send_message` accept `choices` (src/mcp/tools/messaging.ts); there is no answer-needed flag.
- Not verified: how the `status` tool stores its text, and how cc-pool exposes session titles; S96.5 and S96.6 must check before changing them.

## Design

**Terminology.** Surface: a named content stream the agent publishes to (resources below, own revisions, optional `follow` target). Device: a consumer with its own credential, profile (round466, rectangular, and so on), scope (interactive or read-only), link and battery state. Up to about 10 devices per surface. Pairing creates a device, binds it to a surface and issues a credential. The current config entries `iphone-proto` and `intercom-test` become surfaces with a migration that turns their existing token into a legacy device credential.

**Resources** (JSON, each with a monotonic `rev` per surface): `faces`, `events`, `slots`, `widgets`, `sessions`, `notices`, `conversations` (on demand), plus per-device `device` state. Object shapes (Event, slot, session, conversation) and bounds are in architecture.md section 3 and are the contract for this epic; deviations go back into that document first.

**Transport.** New paths under `/api/v1/surface`: `GET /state` (snapshot with revs), `GET /conversations/{id}`, `GET /assets/{hash}`, `POST /actions`, `POST /pair`, `GET /health`, and the WebSocket `/api/v1/surface/ws` (protocol v2: v1 frames kept, plus `delta`, `action`, `view`, and voice frames reserved for a later epic). `/api/v1/intercom/*` remains an alias until the web prototype migrates.

**Listener.** A second Fastify listener serves only the surface API and static prototype, bound to `0.0.0.0` on its own port with TLS. bus-core's other routes stay on `127.0.0.1:3000`. The certificate is a private CA or self-signed certificate; the pairing payload includes its fingerprint so devices can pin it.

**Actions and jobs.** An action references a stored job. A job is the scheduler's item shape with a trigger of `action` instead of a time: when the action arrives, the stored payload is injected into the inbound pipeline exactly as a scheduled fire is. Actions are one-shot by default, idempotent by key, expire with their object, and any action that sends on Chris's behalf carries the exact draft in `confirm.draft`, shown on the device before the tap fires it.

**Agent tools (MCP).** Surface publishing tools (create/update/remove Event, set slot override, write widget data), `subject` added to `status`, `answer_needed` added to `reply`/`send_message` next to `choices`. Tool names and exact schemas are settled in S96.5.

## Entry Criteria

- Chris has read architecture.md and confirmed the surface/device split and the separate-listener approach (done Nov 3).
- The dev checkout is clean; work happens on a branch off `dev` in a worktree.

## Exit Criteria

- Two devices paired to one surface both receive the same `delta` after an agent creates an Event; revoking one device closes its socket and leaves the other connected.
- A device that reconnects with a stale `revs` map receives either the missed deltas or a reset instruction, and a fresh `/state` matches the pushed result.
- The surface listener accepts TLS on the LAN interface and refuses every non-surface route; with the surface listener up, bus-core's own API and MCP are not reachable from another host.
- An Event action fires its job exactly once for repeated taps with the same idempotency key, returns `already_done` the second time, and `expired` after the Event's expiry.
- An action with `confirm.draft` is rejected if the device sends it without the draft being present in the object.
- `reply` with `answer_needed` marks its session `needs_you` in the sessions resource until a button tap, a reply, or an explicit clear.
- The existing iPhone prototype at `/intercom/` continues to work unchanged through the alias.
- Full suite passes, `tsc` clean, docs updated.

## Stories

### S96.1 — Surface and device model

- Add `surfaces` and `devices` tables; migrate the two configured entries into surfaces plus a legacy device each.
- Device credential issue, hash storage, revoke, list. Scope field (interactive or read-only). Profile field.
- Pairing creates a device bound to a surface; the pairing payload includes the listener's certificate fingerprint (filled in once S96.2 lands).
- CLI: `scripts/surface-pair.ts` (successor of `intercom-pair.ts`, which keeps working) and `scripts/surface-devices.ts` (list, revoke).

**Acceptance:** pair two devices to one surface; list shows both; revoke one; the revoked credential gets 401 and the other still works.

### S96.2 — Separate TLS listener

- Second listener for `/api/v1/surface/*` and static web files, own port and bind address, TLS with a configured key/cert (generator script for a private CA and server cert).
- Config: `surface_api: {enabled, host, port, tls: {cert, key}}`.
- Refuses all other paths with 404; does not share the bus `X-Bus-Token` auth.

**Acceptance:** from a second host on the LAN, the surface API answers over TLS and `GET /api/v1/status` (a bus route) does not; on localhost the original port still serves everything.

### S96.3 — Resource store, snapshot and delta push

- Per-surface resource store with `rev`, `set/patch/remove` ops, retention for replay, bounds validation.
- `GET /state`; protocol v2 `delta` events; `hello` accepts `revs`; resume or `reset` per resource; keep v1 `cursor` semantics for legacy clients.
- Throttling: coalesce rapid changes to a resource (at most one delta per resource per 250 ms).

**Acceptance:** write 5 changes while a client is disconnected, reconnect with old revs, receive the 5 (or a reset), final state equals `/state`.

### S96.4 — Actions and action-triggered jobs

- `POST /actions` and WS `action` frame, one handler.
- Job store with `trigger: action`; payload injected into the inbound pipeline like a scheduler fire; idempotency keys with TTL; `once`, `expires`; result frame (`done|failed|expired|already_done`).
- `confirm.draft` rule enforced server-side.
- Existing E89 notification actions routed through the same handler (behaviour unchanged for current clients).

**Acceptance:** an Event "I'm here" action sends the stored payload once; second tap returns `already_done`; tap after expiry returns `expired`.

### S96.5 — Agent publishing tools

- MCP tools for Events (create, update, remove), slot override (with `until`), and widget data writes; `subject` on `status`.
- Validation and bounds from architecture.md; clear error messages for the agent.
- Per-agent authorisation: which surface an agent may publish to (config).

**Acceptance:** an agent call creates an Event with a button; both paired devices receive it; an over-limit call is rejected with a readable error.

### S96.6 — Answer-needed flag and sessions resource

- `answer_needed` on `reply`/`send_message` (with `choices`); stored on the conversation.
- Sessions resource built from E94's classification, extended with `subject`, `needs_you`, 30-minute activity timeout (configurable), system sessions excluded by default (configurable).
- Flag clears on button tap, reply or explicit clear tool.

**Acceptance:** a reply with `answer_needed: true` shows `needs_you` in the sessions resource; tapping a button clears it; a reply without the flag never sets it.

### S96.7 — Conversation endpoint and approval objects

- `GET /conversations/{id}` paged transcript (text only, no tool output) with buttons; live append over the WS while the device reports `view` = that conversation.
- Approval objects: kind `approval` with the exact draft or command description, for send-on-behalf actions and passed-through bus approvals (the existing approvals module).

**Acceptance:** a transcript pages correctly with `before`; an approval from the harness appears as an Approval object and its Approve/Deny round-trips through the existing approvals path.

### S96.8 — Docs, alias and migration of the web prototype

- `docs/SURFACE_API.md` (contract), update `docs/INTERCOM.md`, `site-docs`, `CHANGELOG.md`.
- `/api/v1/intercom/*` alias verified; a note and test showing the web prototype works unchanged.
- Migration note for the rename (AgentBus to Intercom) so paths do not change again.

**Acceptance:** the existing web prototype passes its suite against the alias; docs describe every endpoint and frame in the epic.

## Out of scope (follow-on epics)

- Web client updates for Day Dial v2, Agent Status v2, Conversation, Approval, Card and Picker views (E97).
- Sandboxed custom widget runtime (location tbd) and the standard widget set (E98).
- Voice streaming, transcription and spoken replies (builds on E92).
- Compact firmware and the phone relay app.
- AgentBus to Intercom rename.

## Risks

- Scope: eight stories touching intercom, scheduler, MCP tools and HTTP. Mitigation: stories are ordered so each leaves the system working; merge after S96.3 is possible.
- Exposing a LAN port. Mitigation: separate listener, TLS, per-device credentials, revocation, rate limits, no bus routes reachable.
- Action-triggered jobs can send messages on Chris's behalf. Mitigation: `confirm.draft` rule, one-shot, expiry, idempotency.
- Certificate handling on a microcontroller is fiddly. Mitigation: pin at pairing; confirm with a firmware spike before S96.2 is final.
- Migration of existing paired devices. Mitigation: legacy device credential preserves the phone's token.
- Epic-numbering collision: desk mode used the label E94, which the backlog reserves for wake word. Mitigation: rename or note in the backlog before merging.
