# E10 — Adapter Capabilities (Reactions, markRead, Typing)

| Field | Value |
|---|---|
| Epic ID | E10 |
| Build Order Position | 10 of 12 |
| Dependencies | E3 (Telegram adapter with capabilities), E4 (BlueBubbles adapter with capabilities), E7 (`react_to_message` tool registered) |
| Story Count | 3 |
| Estimated Complexity | S |

---

## Epic Summary

E10 wires the capability system together end-to-end. Individual adapters declared their capabilities in E3 and E4; E10 ensures the bus actually uses those declarations to gate optional behaviors, implements the post-delivery `markRead` flow as a non-blocking async operation, and connects the `react_to_message` MCP tool through to the correct adapter's `react()` method. After E10, reactions and read receipts are fully operational across all channels that support them.

---

## Entry Criteria

- E3 complete: Telegram adapter's `capabilities` object is declared with `canReact: false`, `canMarkRead: false`, `canTypingIndicator: true`
- E4 complete: BlueBubbles adapter's `capabilities` object is declared with `canReact: true`, `canMarkRead: true`, `canTypingIndicator: false`
- E7 complete: `react_to_message` tool is registered and performs a capability check stub
- `AdapterRegistry` supports `lookup(adapterId).capabilities` access
- Delivery worker exists in each adapter (polls queue and dispatches outbound messages)

---

## Exit Criteria

- `react_to_message` called on a Telegram message returns `{ success: false, reason: "Reactions not supported on channel: telegram" }` without calling any adapter method
- `react_to_message` called on a BlueBubbles message calls `adapter.react()` and returns `{ success: true }`
- After every successful outbound message delivery, `adapter.markRead()` is called asynchronously if `canMarkRead` is true
- `markRead` failures do not affect delivery acknowledgment or queue state
- Typing indicator is sent before outbound delivery on Telegram (canTypingIndicator: true)
- All capability checks are centralized in a single `CapabilityChecker` utility, not scattered across handlers

---

## Stories

### S10.1 — Capability Check Routing

**User story:** As the bus, I want a centralized capability checker that validates adapter support before calling optional methods so that unsupported features fail gracefully with clear errors instead of crashing or silently no-oping.

**Acceptance criteria:**
- `CapabilityChecker` utility exposes: `assertCan(adapterId: string, capability: keyof AdapterCapabilities): void` — throws `CapabilityNotSupportedError` if the adapter doesn't declare the capability; and `can(adapterId: string, capability: keyof AdapterCapabilities): boolean` — returns the boolean without throwing
- `AdapterCapabilities` interface defines: `{ canReact: boolean, canMarkRead: boolean, canTypingIndicator: boolean, canRegisterCommands: boolean, channels: string[] }`
- `react_to_message` tool handler uses `CapabilityChecker.can(adapterId, "canReact")`; if false, returns `{ success: false, reason: "Reactions not supported on channel: <channel>" }` (no throw)
- `CapabilityNotSupportedError` extends `Error` with `adapterId` and `capability` fields for structured logging
- Unit test matrix: for each combination of adapter + capability, verify correct `true`/`false` result and that `assertCan` throws appropriately

**Complexity:** S

---

### S10.2 — `markRead` Post-Delivery Flow

**User story:** As the bus, I want read receipts to be sent automatically after successful message delivery so that senders see their messages have been seen, without this operation blocking or failing the delivery acknowledgment.

**Acceptance criteria:**
- The delivery worker in each adapter, after a successful `ack()` call on the bus queue, checks `CapabilityChecker.can(adapterId, "canMarkRead")`
- If true, calls `adapter.markRead(originalMessageId, chatContext)` wrapped in a `Promise.resolve().then(...)` to ensure it runs after the current tick (non-blocking relative to ack)
- `markRead` errors are caught, logged at `warn` level, and do not propagate — delivery is already complete and ack'd
- The `originalMessageId` passed to `markRead` is the source message's ID from the inbound transcript, retrieved from the outbound envelope's `reply_to_message_id` field (if present)
- If `reply_to_message_id` is absent (e.g., a proactive outbound message), `markRead` is skipped
- Integration test: deliver a reply to a BlueBubbles message → verify `markRead` called with correct message ID; deliver to Telegram → verify `markRead` not called

**Complexity:** S

---

### S10.3 — `react_to_message` End-to-End Wiring

**User story:** As Peggy, I want `react_to_message` to work end-to-end — from MCP tool call through transcript lookup to adapter reaction — so that I can send emoji reactions that actually appear in the user's messaging app.

**Acceptance criteria:**
- `react_to_message({ message_id, emoji })` flow: look up `message_id` in `transcripts` → extract `adapter_id` and `channel` → call `CapabilityChecker.can(adapterId, "canReact")` → if true, call `adapter.react(messageId, emoji)` → return `{ success: true, emoji, message_id, channel }`
- If `transcripts` lookup returns no result, returns `{ success: false, reason: "Message not found in transcript: <message_id>" }`
- If capability check fails, returns `{ success: false, reason: "Reactions not supported on channel: <channel>" }` (no adapter call made)
- If `adapter.react()` throws, catches and returns `{ success: false, reason: error.message }`
- The BlueBubbles adapter's `react()` implementation performs the emoji → tapback integer mapping (defined in E4 S4.3) and calls the BlueBubbles API
- End-to-end integration test with mocked BlueBubbles API: call `react_to_message` → verify `POST /api/v1/message/{id}/react` called with `{ tapback: 0 }` for `❤️`

**Complexity:** S

---

## Notes

- **Centralization rationale:** The `CapabilityChecker` utility prevents each tool handler and delivery worker from independently inspecting `capabilities` objects. Having one place makes it easy to add new capabilities or change the check logic without hunting down all call sites.
- **`markRead` in BlueBubbles requires `chat_guid`:** The `markRead(messageId, chatGuid)` signature for BlueBubbles needs the chat GUID, which is stored in the original message's `metadata`. The delivery worker must retrieve this from the outbound envelope's metadata before calling `markRead`. If metadata is missing, log a warning and skip.
- **Typing indicator as a capability:** `canTypingIndicator` is declared but E10 doesn't fully implement the typing indicator sending (that's already in E3's `sendTyping()`). E10 ensures the delivery worker calls `sendTyping` before calling `sendMessage` if `canTypingIndicator` is true. It's a one-line addition to the Telegram delivery path, but it's wired here for correctness.
- **Future capabilities:** The `AdapterCapabilities` interface should be designed to be extensible. Suggested candidates for future epics: `canThread` (threaded replies), `canEditMessage`, `canDeleteMessage`, `canSendFile`. Use optional boolean fields (`canThread?: boolean`) to stay backward compatible.
- **`react_to_message` is already partially implemented in E7.** E10's role is to complete the implementation — E7 had the capability check stub returning a placeholder. E10 adds the actual adapter dispatch. Coordinate which story owns the final implementation to avoid conflicts.
