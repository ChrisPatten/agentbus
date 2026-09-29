# E54 — Telegram Topic Pinned-Message Context

| Field | Value |
|---|---|
| Epic ID | E54 |
| Dependencies | E27 (Generic Thread Store), E28 (Telegram Group Topics) — both live |
| Story Count | 3 |
| Complexity | S–M |

## Epic Summary

When a user message in a Telegram group topic starts a **new session**, include the topic's pinned message (if any) in the initial prompt so the agent has context for what the topic is about. Requested by Chris, 2026-09-28.

Related: E28 S28.x (reply-quote-as-context) and the one-shot "first message" context that `create_telegram_topic` already injects (`src/adapters/telegram.ts`, consumed and cleared on a topic's first inbound message) — this epic generalizes that hook to topics that were not created by the agent.

## Open technical question (spike first)

The Telegram Bot API has no "get pinned message for topic X". `getChat` returns a single `pinned_message` for the chat, which is not reliably topic-scoped in forum groups. Candidate mechanisms, to be verified against a real group before building:

1. **Track pin events**: the `pinned_message` service message carries `message_thread_id` and the pinned message body. Persist the latest per topic in the E27 thread metadata (`TelegramThreadMetadata`). Pro: topic-accurate. Con: misses pins made before the bot joined or before this ships (mitigate with fallback 2).
2. **`getChat` fallback**: use `pinned_message` if its `message_thread_id` matches the topic.
3. Confirm whether the bot can see pin service messages given the group's Privacy Mode setting (Privacy is expected off per E28 setup).

## Exit Criteria

1. Spike result documented: which mechanism reliably yields a topic's pinned message.
2. On the first inbound message that creates a new session for a topic, the prompt includes the pinned message text, clearly labeled (e.g. "Pinned in this topic: …"); no pinned message means no change.
3. Not re-injected on subsequent turns of an existing session; re-injected only if a new session starts.
4. Tests: pinned present, pinned absent, pin updated, non-topic (General/DM) unaffected.
5. Docs + CHANGELOG. Full suite green, `tsc --noEmit` clean.

## Stories

### S54.1 — Spike: obtain a topic's pinned message
Verify against a private test group (Topics on, Privacy off) what `getChat` and `pinned_message` service updates actually return per topic. Record findings in this file and pick a mechanism.

### S54.2 — Persist/lookup pinned message per topic
Implement the chosen mechanism: store the latest pinned message (text, message id, timestamp) in the topic's thread metadata on pin/unpin service events, with `getChat` fallback if the spike supports it. Handle unpin (clear).

### S54.3 — Inject on new-session start
On new-session creation for a thread topic, prepend the pinned message to the initial prompt, sharing the injection path with the `create_telegram_topic` one-shot context. Cap length (truncate long pins). Tests per exit criteria; docs/CHANGELOG.
