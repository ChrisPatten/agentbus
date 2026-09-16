# E46 — Peggy as a Siri AI Source: Messages Domain + Semantic Index

| Field | Value |
|---|---|
| Epic ID | E46 |
| Dependencies | E43, E45 (MVP shipped). E35 (`GET /api/v1/sessions/:id/transcript`) for sync. |
| Story Count | 7 |
| Estimated Complexity | L |
| Planning package | `siri-bridge/architecture.md` §13.1; `research-ios27-siri.md` §3; `PRD.md` FR-30…FR-33 |

---

## Epic Summary

Make Peggy a first-class *contact* in Siri AI's world. By adopting the
Messages app-schema domain, the Peggy app tells Siri what a Peggy message is,
who Peggy is, and how to send her one — so "Send a message to Peggy asking
whether the mooring invoice was paid" is one natural utterance (Siri AI fills
recipient and content from the schema), replies arrive as `MessageEntity`s,
and — the actual goal of this initiative — Peggy's replies are indexed in the
on-device **semantic index** so Siri AI can answer "what did Peggy say about
the boat insurance?" itself, with no round trip.

Apple's rule: adopt one Messages schema and Xcode requires all five
(`draftMessage`, `sendMessage`, `editSentMessage`, `unsendMessage`,
`setMessageReadStatus`). Three of them are near-no-ops for us; that is the
price of one-shot natural language and semantic recall.

---

## Entry Criteria

- MVP in daily use (Gate 3). Operator confirms the two-step "What would you like to ask Peggy?" prompt is worth removing and/or wants semantic recall.

## Exit Criteria

1. "Send a message to Peggy asking …" / "Tell Peggy …" works via Siri AI without the follow-up prompt; if Peggy answers within budget Siri speaks it, otherwise Siri confirms "Sent" and the reply arrives as a notification that supports "Reply …" on AirPods.
2. Peggy's Siri-channel transcript (and, opt-in, other channels) is mirrored into the app and indexed; five recall questions are answered by Siri AI from indexed messages (recorded in `spike-results.md`).
3. Index stays correct: new messages indexed within one sync; deletions removed; `IndexedEntityQuery` reindex works.
4. Docs: `apps/ios/Peggy/README.md` (Messages features), `docs/SIRI_ADAPTER.md` (sync endpoints used, optional push).

---

## Stories

### S46.1 — Entities: `PeggyPersonEntity`, `ConversationEntity`, `MessageEntity` (+ `IndexedEntity`)

**Acceptance criteria:**
1. Entities per architecture §13.1 with `@AppEntity(schema: .messages.*)`; `MessageEntity: IndexedEntity` with `@Property(indexingKey: \.textContent)` on the body; `DisplayRepresentation` with Peggy's avatar for the person, first line of body for messages.
2. Entity queries backed by SwiftData (`EntityQuery` by id; `EntityStringQuery` for messages by substring as the non-semantic fallback); `IndexedEntityQuery` implemented for reindex.
3. `OwnershipProvidingEntity` not adopted (Peggy conversations are private) — documented.
4. Unit tests for queries.

**Complexity:** M

### S46.2 — The five Messages schema intents

**Acceptance criteria:**
1. `sendMessage`: builds the outbound `MessageEntity`, calls `POST /api/v1/siri/ask` with `wait_ms = min(waitBudget, 15 s)` (shorter than the custom intent — Siri AI's own overhead is larger), returns `ReturnsValue<MessageEntity> & ProvidesDialog`: reply body if answered, else "Sent to Peggy — I'll let you know when she answers." and schedules the background fetch (S45.2 component reused, with entity-annotated notification from S46.5).
2. `draftMessage`: foreground; opens the in-app compose view pre-filled.
3. `editSentMessage`, `unsendMessage`: throw a user-facing `PeggyIntentError.unsupported` with clear dialog.
4. `setMessageReadStatus`: toggles a local flag; indexed entity updated.
5. Xcode build passes the schema-group validation; AppIntentsTesting covers all five.

**Complexity:** M

### S46.3 — Transcript sync from the bus

**Acceptance criteria:**
1. `TranscriptSync` actor: `GET /api/v1/sessions?contact_id=&channel=siri` → `GET /api/v1/sessions/:id/transcript?since=` incremental; opt-in toggle per channel (`telegram:peggy`, `bluebubbles`) in Settings ("Mirror other channels into Siri's index").
2. Runs on foreground, after each `sendMessage`, and via `BGAppRefreshTask` (~15 min, best effort); idempotent on `message_id`.
3. Bus: the siri bearer token must be accepted by the two session endpoints **or** a scoped read endpoint `GET /api/v1/siri/transcripts?since=` is added that reuses the same query — choose the latter if touching the global auth hook is risky; document.
4. Tests: incremental merge; channel opt-in; idempotency.

**Complexity:** M

### S46.4 — Semantic index maintenance

**Acceptance criteria:**
1. `CSSearchableIndex(name: "peggy-messages").indexAppEntities(_:)` after every sync batch (chunked ≤ 200); delete by identifier on removal; full reindex on `IndexedEntityQuery` request and from a Settings "Rebuild index" button.
2. Entity size stays far below the 10 MB cumulative limit (bodies capped at 8 KB; attachments not indexed).
3. Spotlight search on device finds Peggy messages by keyword (manual check recorded).

**Complexity:** S

### S46.5 — Notifications with entity annotations

**Acceptance criteria:**
1. Reply notifications set `content.appEntityIdentifiers = [EntityIdentifier(for: MessageEntity.self, identifier: id)]`; announced on AirPods, "Reply, thanks" invokes `sendMessage` with the conversation context.
2. Threaded by conversation; Lock Screen preview toggle respected.

**Complexity:** S

### S46.6 — Optional: APNs push for new Peggy messages

**Acceptance criteria:**
1. Bus: `src/push/apns.ts` (token-based `.p8`, HTTP/2 `fetch` to APNs, `content-available: 1` background push), `POST /api/v1/siri/devices` (register/unregister device token, bearer-scoped), config `adapters.siri.push: { key_id, team_id, key_path, bundle_id, environment }`; `SiriAdapter.send()` triggers a push after storing a late/unsolicited reply.
2. App: `aps-environment` entitlement, `didRegisterForRemoteNotifications` → register with the bus; background push triggers `TranscriptSync` + notification.
3. Fully optional: absent config → nothing changes; documented as such.

**Complexity:** M

### S46.7 — Validation: one-shot NL + five recall questions

**Acceptance criteria:**
1. Recorded in `spike-results.md`: five "what did Peggy say about …" questions answered by Siri AI from the index (no bus call in the logs); three one-shot send phrasings; AirPods reply flow.
2. Decide whether `AskPeggyIntent` (custom) stays as a second entry point (keep if the one-shot path is less reliable); remove dead code otherwise.

**Complexity:** S

---

## Notes

- **Privacy:** the semantic index is on-device (Spotlight); mirroring Telegram/iMessage conversations into it is opt-in per channel.
- **Why replies are `MessageEntity`s rather than notes:** session 343 ties semantic Q&A to schema domains; Messages is the natural domain for an agent conversation and needs no new bus concepts.
- **Existing channels unchanged:** the app mirrors transcripts read-only; sending still goes through the `siri` channel so Peggy's Siri conversation keeps its own `--resume` continuity.
