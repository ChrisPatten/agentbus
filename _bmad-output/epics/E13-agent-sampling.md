# E13 — Agent-Initiated Sampling (Proactive Message Delivery)

| Field | Value |
|---|---|
| Epic ID | E13 |
| Build Order Position | 13 of 13 |
| Dependencies | E2 (cc adapter, MCP server scaffold, reply tool) |
| Story Count | 3 |
| Estimated Complexity | M |

---

## Epic Summary

E13 closes the trigger gap in the Claude Code adapter. In the current implementation (E2), the cc adapter polls the bus and buffers inbound messages, but has no mechanism to wake Claude Code when a message arrives — Claude Code only processes buffered messages if it is already mid-turn or if a human types something. Without the `--channels` flag (which is being replaced by AgentBus), the agent sits idle even as messages accumulate.

This epic implements `sampling/createMessage` — the MCP-native mechanism for an MCP server to ask the connected Claude Code client to generate a response. When the polling loop finds new messages, it fires `createMessage` with the message content as the conversation context. Claude Code wakes up, reads the message, and calls `reply` to respond. This makes the agent fully autonomous: it responds to Telegram (and other channel) messages without any human prompt.

---

## Entry Criteria

- E2 complete: cc adapter is running, `reply` tool is registered, polling loop is operational
- E3 complete: Telegram adapter delivers inbound messages to the bus
- E5 complete: inbound pipeline routes messages to `agent:claude`
- Claude Code version in use supports `sampling/createMessage` client capability (verify at runtime)

---

## Exit Criteria

- Sending a Telegram message to the bot causes the agent to wake up and generate a reply within a few seconds, with no human interaction required
- If Claude Code does not declare the `sampling` capability, the adapter logs a clear error and falls back to the buffering approach (no crash)
- Concurrent messages are serialized — if a second message arrives while the agent is responding to the first, it is queued and delivered after the current turn completes
- The `createMessage` call includes sufficient context for the agent to respond correctly: sender, channel, message body, and message ID for use with `reply`
- All errors from `createMessage` (timeout, client rejection, tool call failures) are caught and logged; failed messages are not lost — they remain in `messageBuffer` for manual recovery via `get_pending_messages`

---

## Stories

### S13.1 — Sampling Capability Negotiation

**User story:** As the cc adapter, I want to detect at startup whether Claude Code has declared the `sampling` capability so that I can enable proactive message delivery when supported and degrade gracefully when not.

**Acceptance criteria:**
- After MCP transport connects, adapter reads client capabilities from the handshake
- If `sampling` capability is present, adapter sets an internal `samplingAvailable = true` flag and logs confirmation
- If `sampling` capability is absent, adapter logs a warning and continues in buffering-only mode (existing behavior); `get_pending_messages` tool remains available for manual polling
- Capability check is done once at connection time; result is not re-checked per message
- Unit test: mock client with and without `sampling` capability; verify flag is set correctly in both cases

**Complexity:** S

---

### S13.2 — `createMessage` Trigger on Inbound Messages

**User story:** As the agent, I want the cc adapter to call `sampling/createMessage` when new messages arrive so that I am woken up and given the message context without requiring a human to type anything.

**Acceptance criteria:**
- When the polling loop dequeues ≥1 new messages and `samplingAvailable` is true, adapter calls `mcpServer.createMessage()` with the messages formatted as a user turn
- Message format passed to `createMessage`:
  ```
  New message from {sender} via {channel} [id:{message_id}]:
  {body}
  ```
  Multiple messages in a single poll batch are concatenated as separate paragraphs in one user turn
- `maxTokens` is set to a configurable value (default: 8192)
- `createMessage` is called asynchronously from the polling loop — the polling loop does not await the response; it fires and continues polling
- If `createMessage` rejects (error), log the error at `error` level; do not remove the messages from `messageBuffer` (they remain retrievable via `get_pending_messages`)
- Integration test: enqueue a message → poll → verify `createMessage` is called with correct content

**Complexity:** M

---

### S13.3 — Message Queue Serialization

**User story:** As the agent, I want inbound messages to be delivered to me one batch at a time so that I am not overwhelmed by overlapping `createMessage` calls if messages arrive faster than I can respond.

**Acceptance criteria:**
- A simple async queue (FIFO) serializes `createMessage` calls — only one is in-flight at a time
- If a new message arrives while a `createMessage` is pending, the new message is appended to `messageBuffer` and a new `createMessage` call is enqueued (not fired immediately)
- After each `createMessage` call completes (success or error), the queue checks for pending messages and fires another call if any exist
- Queue state is logged at `debug` level: "createMessage in flight, queuing {n} message(s)"
- The queue has no maximum depth — all messages are eventually delivered (no drops)
- Unit test: simulate 3 rapid messages; verify exactly 3 sequential `createMessage` calls with no overlap

**Complexity:** M

---

## Notes

- **Why not await `createMessage` in the polling loop?** Awaiting would block the loop for the full duration of the agent's response (potentially 10–30s), causing inbound messages to pile up unacked. Fire-and-forget with a serialization queue is the right pattern.
- **`createMessage` vs. `sendLoggingMessage`:** `sendLoggingMessage` only reaches Claude if it is already mid-turn. `createMessage` initiates a new turn. E2 used `sendLoggingMessage` as a stopgap; this epic replaces it with the proper mechanism.
- **Tool call handling in `createMessage` response:** The response from `createMessage` may contain tool calls (e.g., `reply`). Claude Code handles tool call execution as part of its normal MCP loop — the cc adapter does not need to intercept or re-execute them. The `createMessage` response is informational and can be discarded.
- **the agent's CLAUDE.md:** Update the agent's instructions to describe how AgentBus messages arrive (via `createMessage`) and remind the agent to use the `reply` tool with the message ID from the delivered context. This is a docs change, not a code change, but it is a required part of this epic's exit criteria.
- **Fallback path:** The `get_pending_messages` tool remains registered and usable. If sampling is unavailable (older Claude Code version), a human can trigger the agent manually or a `/loop` skill can be configured as a stopgap.
