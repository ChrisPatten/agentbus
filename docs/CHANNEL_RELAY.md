# Channel Relay (`pipeline.relays`)

A general-purpose pipeline capability: re-arrive a message on a **different
channel**, with its **body rewritten** from a template, while **preserving
the sender**. This is distinct from `pipeline.routes` (Stage 70,
`route-resolve`), which only picks a delivery target (agent) for a message
that has already arrived — it never changes the message's channel or body.

Typical use: a message lands on a receive-only ingress channel (e.g. the
[Pebble Ring webhook](PEBBLE_ADAPTER.md)) and should be forwarded into an
existing conversation on another channel, wrapped with some context.

---

## How it works

```yaml
pipeline:
  relays:
    - match: { channel: pebble, sender: "contact:chris" }
      target:
        channel: "telegram:peggy"
        template: "Pebble ring voice note:\n{{body}}"
```

- **`match`** — identical shape to a route rule's `match`
  (`sender`/`channel`/`topic`, all optional, AND-ed). Rules are evaluated in
  order; the first match wins. An empty match (`{}`) is a catch-all — a
  construction-time warning is logged if one appears before the last rule.
  **`match.channel` also matches a group derived from it** (E28) —
  `channel: "telegram:peggy"` matches both `telegram:peggy` itself and any
  `telegram:peggy:group:<chatId>`, via the shared `channelMatches()` helper
  (`src/pipeline/types.ts`) both this stage and `route-resolve` use, not raw
  string equality. No separate rule is needed to cover a bot's groups.
- **`target.channel`** — the channel the new message will arrive on.
- **`target.template`** — rendered with `{{body}}`, `{{sender}}`, and
  `{{channel}}` (the *source* channel) substituted. Defaults to `'{{body}}'`
  (passthrough — same body, new channel, no wrapper text). Uses the same
  `{{variable}}` substitution `renderSystemPrompt` uses for cc-headless
  system prompts (`src/adapters/prompt-renderer.ts`); an unknown placeholder
  is left as-is rather than silently dropped.

On a match, the `channel-relay` stage (Stage 25 — runs after `contact-resolve`
at 20, before `dedup` at 30) renders the template and re-submits the result as
a **brand-new inbound message** via the same shared `processInbound()` path
the HTTP API and platform adapters use. That new message runs the *entire*
pipeline again from the top — dedup, topic-classify, priority-score,
route-resolve, transcript-log — exactly as if it had arrived on
`target.channel` natively. The *original* message's own pipeline run is then
aborted (`channel-relay` returns `null`), so it never reaches dedup or
route-resolve on its original channel.

No rule matches → the message proceeds through the normal pipeline
completely unchanged. An empty or omitted `pipeline.relays` behaves
identically to a config with no relays at all — this is purely additive.

---

## Worked example: Pebble Ring → Telegram

Route a Pebble Ring voice memo into an existing Telegram conversation, with a
prefix identifying where it came from:

```yaml
contacts:
  chris:
    id: chris
    displayName: Chris
    platforms:
      pebble:
        token: "s3cr3t-bearer-token-for-chris"
      telegram:
        userId: 123456789

pipeline:
  relays:
    - match: { channel: pebble, sender: "contact:chris" }
      target:
        channel: "telegram:peggy"
        template: "Pebble ring voice note:\n{{body}}"

  routes:
    - match: { channel: "telegram:peggy" }
      target: { adapterId: "cc-headless:peggy", recipientId: "agent:peggy" }
```

A memo transcribed as "buy oat milk" arrives on `pebble`, sender resolves to
`contact:chris` (see [PEBBLE_ADAPTER.md](PEBBLE_ADAPTER.md)), and the relay
rule re-submits it as a new message on `telegram:peggy` with body "Pebble
ring voice note:\nbuy oat milk", sender still `contact:chris`. That message
then routes to `agent:peggy` exactly like any other Telegram message from
Chris — same conversation, same session.

---

## Dedup after relay

The relayed message gets its **own** dedup entry (Stage 30 keys on
`sender + body + time-bucket`) — independent of the original. Since the
rendered body usually differs from the raw source body (the template adds
text), this is naturally a different dedup key than the source message would
have used directly. A retried/duplicate delivery of the *same source memo*
still produces at most one delivered relayed message, because the second
relay attempt renders the identical body and lands in the same dedup bucket
as the first.

---

## Loop guard

Every relayed message carries `metadata.relay_hops`, incremented on each hop.
Once hops reach **3**, `channel-relay` skips the relay rule for that message
— it falls through to the normal (non-relay) pipeline on whatever channel it
last landed on, with a warning logged. This bounds a misconfigured relay
cycle (e.g. channel A's relay rule points to channel B, and B's relay rule
points back to A) to a fixed number of hops rather than looping forever.

---

## What's preserved / what isn't

- **Sender** is always preserved unchanged.
- **`metadata.relayed_from`** on the relayed message records the source
  `{ channel, id, timestamp }`.
- **No separate transcript row for the original message.** Because
  `channel-relay` aborts the original envelope's pipeline before Stage 80
  (`transcript-log`), the only durable record of the source message is
  `metadata.relayed_from` on the relayed message — there is no orphaned
  transcript row for the raw pre-relay hit.

---

## Related

- [docs/PEBBLE_ADAPTER.md](PEBBLE_ADAPTER.md) — the channel this feature was
  built to unblock
- `_bmad-output/epics/E26-channel-relay-routing.md` — epic scoping and design
  rationale (why a separate schema from `pipeline.routes`, why the whole
  pipeline re-runs rather than hand-wiring delivery)
