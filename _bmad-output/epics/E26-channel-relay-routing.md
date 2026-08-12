# E26 — Channel Relay: Content-Transform Routing

| Field | Value |
|---|---|
| Epic ID | E26 |
| Dependencies | None required to stand alone; usable with any two existing channels today. Most immediately useful paired with E25 (relay `pebble` → `telegram:peggy` with a prepended wrapper), but is a general pipeline capability, not pebble-specific. |
| Story Count | 5 |
| Estimated Complexity | M |

---

## Epic Summary

Stage 70 (`route-resolve`) can already redirect an arrived message to a
different **agent** (`target: { adapterId, recipientId }`) — but it never
changes the message's **channel** or **body**. There is currently no way to
say "a message that lands on channel A, from sender S, should become a *new*
message on channel B, with its content rewritten, keeping the same sender."

E26 adds exactly that as a distinct, general-purpose capability:
`pipeline.relays[]`. A relay rule matches the same way a route rule does
(`sender`/`channel`/`topic`, AND-ed, first match wins), but instead of
picking a delivery target, it **renders a template over the message body and
re-submits the result as a brand-new inbound message on a different
channel**, preserving the original sender. That new message runs through the
*entire* pipeline again from the top — dedup, topic-classify, priority-score,
route-resolve, transcript-log — exactly as if it had arrived on the target
channel natively, so nothing downstream needs to know a relay happened.

```yaml
pipeline:
  relays:
    - match: { channel: pebble, sender: "contact:chris" }
      target:
        channel: "telegram:peggy"
        template: "Pebble ring voice note:\n{{body}}"
```

`template` supports `{{body}}`, `{{sender}}`, and `{{channel}}` (the
*source* channel) placeholders, reusing the `{{variable}}` substitution
already implemented in `src/adapters/prompt-renderer.ts` for cc-headless
system prompts rather than a second templating engine.

---

## Entry Criteria

None.

---

## Exit Criteria

1. A message matching a relay rule never reaches `route-resolve` /
   `transcript-log` on its original channel; instead exactly one new inbound
   message appears on the target channel with the transformed body and the
   original sender preserved, and that message is processed by the full
   pipeline (dedup, routing, delivery) as normal.
2. The relayed message is deduped independently of the original — the same
   source memo delivered twice results in at most one delivered relayed
   message.
3. A relay chain that would loop (a target channel's own relay rule points
   back toward the source, directly or transitively) is detected and halted
   after a bounded number of hops (default 3), with a warning logged. It
   never recurses indefinitely or overflows the stack.
4. No relay rule matches → the message proceeds through the normal pipeline
   completely unchanged. Relays are additive; every existing config with no
   `pipeline.relays` block behaves identically to today.
5. `tsc --noEmit` clean; tests cover template substitution, sender
   preservation, loop detection, dedup-after-relay, and the no-match
   passthrough case.
6. Docs (wherever `pipeline.routes` is currently documented) gain a
   `pipeline.relays` section with the pebble→telegram worked example.

---

## Stories

### S26.1 — Config schema: `pipeline.relays`

**User story:** As an operator, I want to declare relay rules the same way I
declare routes, so the config stays consistent.

**Acceptance criteria:**
1. `RelayRuleSchema`: `match: { sender?, channel?, topic? }` (identical
   shape to `RouteRuleSchema.match`), `target: { channel: string, template:
   string.default('{{body}}') }`.
2. `pipeline.relays: z.array(RelayRuleSchema).default([])` added to
   `PipelineConfigSchema` (`src/config/schema.ts`).
3. Construction-time warning for a non-last catch-all relay rule (`match:
   {}`), mirroring the existing warning in `route-resolve.ts:20-27`.

**Complexity:** S

### S26.2 — `channel-relay` pipeline stage

**User story:** As the bus, I want a message matching a relay rule to be
transformed and re-submitted as a new arrival on the target channel.

**Acceptance criteria:**
1. New stage registered at **slot 25** — between `contact-resolve` (20) and
   `dedup` (30). Early enough to skip wasted downstream work on the original
   envelope; late enough that `ctx.envelope.sender` is already canonicalized
   to `contact:<id>`.
2. On a match: renders `target.template` substituting `{{body}}`,
   `{{sender}}`, `{{channel}}`; builds a new `InboundMessage` with
   `channel: target.channel`, `sender` unchanged, `payload.body` = rendered
   text, `metadata.relayed_from = { channel, id, timestamp }` of the
   original; submits it via the shared inbound-submission path (S26.3) using
   the same `deps` the current pipeline run has.
3. Returns `null` to abort the *original* envelope's pipeline run — no
   dedup/route-resolve/transcript-log for the pre-relay message (see Notes).
4. No match → returns `ctx` unchanged; the pipeline proceeds normally.

**Complexity:** M

### S26.3 — Extract shared inbound-submission path

**User story:** As a maintainer, I want the relay stage to reuse the exact
same enqueue+pipeline logic the HTTP route and platform adapters already use,
without introducing a circular import.

**Acceptance criteria:**
1. `processInbound` (currently defined/exported from `src/http/api.ts`) is
   callable from the new pipeline stage. Confirm this introduces no import
   cycle — `api.ts` wires individual stage modules only indirectly via
   `index.ts`, not by importing them itself, so a stage importing
   `processInbound` from `../../http/api.js` should be safe; verify with
   `tsc --noEmit` and a full build.
2. The `channel-relay` stage factory receives the same `deps` shape
   `processInbound` expects (`queue`, `pipeline`, `config`, `db`, `registry`,
   `commandRegistry`, `pauseSet`), passed in from `index.ts` at the same
   point `route-resolve` etc. are constructed. (The `pipeline` object
   reference already exists by then, even before all stages are registered
   on it — passing the reference, not a snapshot, is sufficient because
   invocation happens later, at request time.)
3. If investigation turns up a genuine layering problem, fall back to
   relocating the shared logic out of `http/api.ts` into a new
   `src/pipeline/submit.ts` importable by both `api.ts` and the relay stage.
   Decide and document whichever path is taken.

**Complexity:** M

### S26.4 — Loop guard

**User story:** As an operator, I want a misconfigured relay chain to fail
safely instead of looping forever.

**Acceptance criteria:**
1. `metadata.relay_hops` (number) increments on every relay hop; once hops
   exceed a small constant (default 3), the relay rule is skipped for that
   message (it proceeds through the normal, non-relay pipeline instead)
   with a warning logged including the channel chain.
2. Test: a two-rule relay cycle (A→B, B→A) terminates within the hop limit
   instead of recursing indefinitely.

**Complexity:** S

### S26.5 — Wiring, docs, tests

**User story:** As a maintainer, I want the feature documented and tested
end-to-end.

**Acceptance criteria:**
1. `index.ts` registers the new stage at slot 25.
2. Docs updated with the `pipeline.relays` config shape, template
   placeholders, and the pebble→telegram worked example.
3. `CHANGELOG.md` entry under `[Unreleased]`.
4. Tests: template rendering, sender preservation, dedup-after-relay,
   no-match passthrough, loop guard.
5. `tsc --noEmit` clean.

**Complexity:** S

---

## Notes

- **Why a separate `pipeline.relays` instead of extending `pipeline.routes`.**
  A route's target answers "which agent should receive this already-arrived
  message"; a relay's target answers "what new message should arrive, and on
  which channel." Overloading one schema for both would make
  `target.adapterId`/`recipientId` vs. `target.channel`/`template` mutually
  exclusive but not enforced as such, and would conflate two different
  pipeline semantics (deliver vs. re-arrive). Two schemas cost a bit more
  code but each stays simple and independently testable.
- **Why re-run the whole pipeline instead of hand-wiring just delivery.**
  The relayed message needs its own dedup entry, its own topic
  classification/priority score, and its own `route-resolve` outcome (which
  agent serves `telegram:peggy`) — all of which already exist and would
  otherwise need to be duplicated or bypassed. Re-submitting through
  `processInbound` gets all of that for free and matches how every other
  channel's messages already flow.
- **The original message's transcript record.** Because the relay stage
  aborts the original envelope's pipeline before Stage 80
  (`transcript-log`), the only durable record of the source message is
  `metadata.relayed_from` on the relayed message — there is no separate
  transcript row for the raw pre-relay hit. This is an intentional
  simplification (it avoids an orphaned transcript row for a message that
  Stage 50/60's topic/priority computation never ran on) but worth
  revisiting if audit requirements later want the raw inbound hit logged
  independently of the relay outcome.
- **Template engine reuse.** `src/adapters/prompt-renderer.ts` already
  implements `{{variable}}` substitution for cc-headless system prompts;
  S26.2 should reuse it rather than hand-rolling a second templating
  implementation.
