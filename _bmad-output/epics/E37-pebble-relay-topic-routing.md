# E37 — Pebble Ring Relay Topic Routing

| Field | Value |
|---|---|
| Epic ID | E37 |
| Dependencies | E27 (Generic Thread Store), E28 (Telegram Group Topics) — both live |
| Story Count | 2 |
| Complexity | S |

## Epic Summary

Route Pebble ring voice notes to their own dedicated Telegram group topic instead of the main conversation, so quick ring throwaways (grocery items, one-off reminders, garbled transcripts) don't clutter the main thread Chris actually converses in.

**Finding that shrinks this epic considerably**: the detection problem this idea originally seemed to need doesn't exist. Every Pebble ring message already arrives on a distinct `channel: 'pebble'` (set directly in the webhook handler, `src/http/api.ts:1506`) and is re-submitted onto `telegram:peggy` by the existing Stage 25 channel-relay rule (`config.pipeline.relays`, matched via `{ match: { channel: 'pebble' } }` — this is the literal source of the "Pebble ring voice note:\n{{body}}" prefix Chris sees on every ring message today). Ring-sourced messages are already unambiguously tagged *before* the relay fires. There is nothing new to detect — only somewhere new to send it.

The actual gap: `RelayTargetSchema` (`src/config/schema.ts:418`) only has `channel` and `template` — no way to also pin a `topic` on the re-submitted envelope. `channel-relay.ts`'s `processInbound()` call (`src/pipeline/stages/channel-relay.ts:~85`) doesn't pass a `topic` field either, so the relayed message falls through to whatever the pipeline's default topic classification produces (effectively `general`) regardless of source. `InboundMessage.topic` is already a first-class optional field consumed directly by `processInbound` (`message.topic ?? ''`, `src/http/api.ts:310`) — so once the relay stage forwards it, the rest of the pipeline (topic-scoped session resolution, E32's conversation-registry keying) needs no further changes at all.

Outbound is already covered by existing behavior: `reply()` auto-resolves the conversation/topic from the message it's replying to (established this session as the safe way to target a topic without guessing), so once an inbound ring message carries `topic: "thread:<hash>"`, any reply to it lands back in that same topic automatically — no separate outbound design needed.

## Entry Criteria

- E27/E28 live (confirmed): `threads` table, `create_telegram_topic` MCP tool, `topic` param on `send_message`/`schedule_message` all in production.
- A destination topic must exist before config can reference it — either created ahead of time via `create_telegram_topic` (returns a `thread:<hash>`) or an existing topic's hash looked up via `get_session`.

## Exit Criteria

1. `RelayTargetSchema` accepts an optional `topic` field.
2. `channel-relay.ts` forwards `rule.target.topic` (when set) as the re-submitted envelope's `topic`; omitted behaves exactly as today (falls through to default classification).
3. Config documentation (`docs/` wherever `pipeline.relays` is documented, plus `config.yaml`'s inline comments) shows a worked example: pinning the `pebble` relay rule to a dedicated ring topic.
4. Tests: a relay rule with `target.topic` set produces a re-submitted envelope carrying that topic (extend `channel-relay.test.ts`, which already asserts on `envelope.metadata['relayed_from']` — same pattern, new assertion); a relay rule with no `target.topic` still produces the current default behavior (regression coverage).
5. `docs/` + `CHANGELOG.md` updated.
6. Full test suite green, `tsc --noEmit` clean.

## Stories

### S37.1 — `target.topic` on relay rules
Add `topic: z.string().optional()` to `RelayTargetSchema` (`src/config/schema.ts:418`). In `channel-relay.ts`'s `processInbound()` call, pass `topic: rule.target.topic` through on the re-submitted message object alongside the existing `channel`/`sender`/`payload`/`metadata` fields — mirroring how `message.topic` already flows through `processInbound` for every other caller. No change needed to `InboundMessage`'s type (the field already exists) or to any downstream pipeline stage (topic-scoped session/conversation resolution already works generically per E27/E32). Unit tests: extend `channel-relay.test.ts` with a case asserting the relayed envelope's `topic` matches `target.topic` when set, and a regression case confirming unset `target.topic` behaves identically to before this change.

### S37.2 — Wire up the real pebble→ring-topic config + docs
Update `config.yaml`'s existing `{ match: { channel: 'pebble' }, target: { channel: 'telegram:peggy', template: 'Pebble ring voice note:\n{{body}}' } }` rule to add `topic: "thread:<hash>"` once Chris has a destination topic (create one via `create_telegram_topic` — a "Ring Notes" or similar topic in the group — or use an existing one). Document the `topic` field on `RelayTargetSchema` and give a worked before/after example wherever `pipeline.relays` is documented. `CHANGELOG.md` entry. This story is mostly operational (needs Chris's topic choice) — the code change is the small, generic S37.1; this story just makes it real for the one relay rule that motivated the epic.

## Notes

- Deliberately did **not** design a new detection mechanism — the premise that one was needed (raised when this idea first came up) turned out to be wrong once the actual channel-relay code was read. `channel: 'pebble'` already is the detection signal; it's consumed by the relay's own `match.channel` today, just never propagated onward as a `topic`.
- `template` on the relay target is untouched — Chris may still want the "Pebble ring voice note:\n" prefix inside the dedicated topic (useful if he ever looks at the topic's history out of context), or may want to drop it now that the topic itself provides that context. Leaving as a config choice, not a code decision.
- Scoped strictly to the `pebble` relay rule's use case, but the `target.topic` field is generic — any future relay rule (not just Pebble) can pin a topic the same way, for free.
- Did not add a `close`/lifecycle story for the ring topic — same open convention question flagged back in E28's notes (does Peggy ever archive a topic), not re-litigated here.
