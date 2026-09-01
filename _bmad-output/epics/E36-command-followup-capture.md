# E36 — Slash-Command Follow-Up Capture + `/torrent` Completion Notification

| Field | Value |
|---|---|
| Epic ID | E36 |
| Dependencies | None structural. Touches `CommandRegistry` (`src/commands/registry.ts`), the post-pipeline command dispatch block in `src/http/api.ts` (`processInbound`), and the custom `/torrent` command in `src/index.ts`. S36.5 reuses `resolveConversationForOutbound`/`logOutboundTranscript` (`src/pipeline/outbound-transcript.ts`, E31). |
| Story Count | 5 |
| Estimated Complexity | M |

---

## Epic Summary

1. **Request** (Chris, 2026-08-31, via Telegram): running `/torrent` with no
   argument today just returns a usage error
   (`src/index.ts:85-97` — `Usage: /torrent <magnet-link>...`). Chris wants
   it instead to ask **"What's the magnet link? 🧲"**, and have the *next*
   message he sends — if (and only if) it's a bare magnet link — route
   straight to the `/torrent` handler instead of going to Peggy as a normal
   conversational turn. He explicitly wants the 🧲 emoji in the prompt "to
   make it fun."
2. **No existing mechanism for this.** Slash commands are detected and
   dispatched entirely within a single inbound turn (`slashCommandDetect`,
   Stage 40, then dispatch in `processInbound`, `src/http/api.ts:282`) —
   there is no concept anywhere of "the next message from this sender
   should be treated specially," stateful across two separate inbound
   turns. A follow-up message with no leading `/` flows straight through
   the normal pipeline to route-resolve → agent fan-out (Peggy), exactly
   like any other message.
3. **Fix: a small, purpose-built "pending follow-up capture" primitive on
   `CommandRegistry`.** `CommandRegistry` (`src/commands/registry.ts`)
   already owns command definitions and is reachable both where `/torrent`
   is registered (`src/index.ts`, has `commandRegistry` in closure scope)
   and where inbound dispatch happens (`src/http/api.ts`'s `processInbound`,
   already receives `deps.commandRegistry`) — no new dependency needs to be
   threaded anywhere. Add:
   - `registerFollowUp(channel, sender, command, validate, ttlMs)` — stores
     `{ command, validate, expiresAt }` keyed by `${channel}:${sender}`,
     overwriting any existing entry for that key (latest wins).
   - `consumeFollowUp(channel, sender)` — looks up and **deletes** the entry
     (single-shot: only the very next message from that sender is ever
     checked, matching Chris's literal ask, regardless of whether it
     matches), returning `{ command, validate } | null`. Expired entries
     (past `expiresAt`) are treated as absent even if not yet swept.
4. **Dispatch hook**: in `processInbound` (`src/http/api.ts`), before the
   existing slash-command dispatch block, add a check for plain-text,
   non-slash-command messages: consume any pending follow-up for this
   `(channel, sender)`; if present and `validate(body)` passes, look up the
   target command via `commandRegistry.lookup(command)` and invoke its
   handler with `[body.trim()]` as `args` — reusing the *exact* same
   response-send + transcript-log code path as a normal bus command
   (refactored into a small shared helper so this isn't a second copy of
   that logic). If the follow-up is absent, expired, or fails validation,
   nothing changes — the message falls through to the normal pipeline
   exactly as today (no capture, no retry, no lingering state).
5. **`/torrent` change**: when invoked with no argument, instead of the
   usage-error body, it registers a follow-up (`validate` = the same
   `startsWith('magnet:')` check the handler already uses) with a
   reasonable TTL (e.g. 10 minutes — generous since it's single-shot
   anyway, just a safety cap against a truly stray unrelated message
   arriving on some unexpected delay) and returns `What's the magnet
   link? 🧲`.
6. **Second request, same conversation**: Chris also wants a completion
   notification — today `/torrent`'s handler (`src/index.ts:93-99`) spawns
   `torrent_to_books.sh` detached (`spawn(..., { detached: true, stdio:
   'ignore' })`, `child.unref()`) and returns immediately; nothing ever
   reports back when the download (which can take anywhere from seconds to
   hours) actually finishes. Fix: attach a `child.on('exit', ...)` listener
   *before* calling `unref()` — `unref()` only affects whether the child
   alone keeps the event loop alive, it does not stop already-registered
   listeners from firing, and bus-core is a long-running process with
   plenty else keeping it alive regardless. On exit, send a follow-up
   message to the same `(channel, sender)` the command came from — reusing
   the exact same out-of-band send pattern E31 already built for this
   (`resolveConversationForOutbound` + `logOutboundTranscript` in
   `src/pipeline/outbound-transcript.ts`, plus `registry.lookupPrimaryByChannel`
   + `adapter.send()`, both already used by the existing command-response
   path in `api.ts`) — no new send mechanism needed, just reuse at a later
   point in time than usual.

---

## Entry Criteria

- None. Additive: new `CommandRegistry` methods, a new pre-check in
  `processInbound`, and a behavior change to `/torrent`'s no-arg case only
  (the with-argument case is unchanged).

---

## Exit Criteria

1. `/torrent` with no argument replies `What's the magnet link? 🧲` instead
   of the old usage-error text.
2. The very next plain-text message from that same sender/channel, if it's
   a bare magnet link (`startsWith('magnet:')`), is routed directly to the
   `/torrent` handler — the download starts, the normal `/torrent` success
   response is sent — and **never reaches Peggy/the agent fan-out** for
   that turn.
3. If that next message is *not* a magnet link, the follow-up is consumed
   (one-shot) and the message proceeds through the normal pipeline exactly
   as it would have without this feature — it reaches Peggy as an ordinary
   message, no special-casing, no error, no stuck state.
4. A follow-up that sits unconsumed past its TTL (e.g. Chris runs
   `/torrent`, then goes quiet for over 10 minutes before sending anything
   else) is treated as expired on the next check — does not fire on some
   unrelated message sent much later.
5. `/torrent <magnet-link>` (the existing direct-argument form) is
   completely unchanged — this epic only adds the no-arg prompt-and-capture
   path.
6. The mechanism is generic enough (keyed by command name + a validator
   function, not hardcoded to `/torrent`) that a future command could reuse
   it, even though only `/torrent` is wired up to use it now.
7. When a torrent download finishes (whether it was started via the
   direct-argument form or the new prompt-and-capture form), Chris receives
   a follow-up message in the same channel/topic reporting success or
   failure — without needing to ask or check logs himself.
8. A failed download (non-zero exit code) is reported distinctly from a
   successful one, not silently treated the same.

---

## Stories

### S36.1 — `CommandRegistry` follow-up capture primitive

**User story:** As a bus command, I want to register "check the next
message from this sender for X" without building my own stateful tracking.

**Acceptance criteria:**
1. `CommandRegistry` gains a private `Map<string, { command: string;
   validate: (body: string) => boolean; expiresAt: number }>` keyed by
   `` `${channel}:${sender}` ``.
2. `registerFollowUp(channel, sender, command, validate, ttlMs)` sets/
   overwrites the entry.
3. `consumeFollowUp(channel, sender)`: deletes and returns the entry's
   `{ command, validate }` if present and `Date.now() < expiresAt`;
   returns `null` and still deletes if present but expired; returns `null`
   if absent. Always deletes on read (single-shot semantics) — a second
   call immediately after always returns `null`.
4. Unit tests: register → consume returns the right command/validate pair
   and a second consume returns `null`; register → wait past TTL (fake
   timers) → consume returns `null`; two different `(channel, sender)`
   keys don't collide; re-registering the same key before consumption
   overwrites (latest wins, doesn't stack).

**Complexity:** S

### S36.2 — Dispatch hook in `processInbound`

**User story:** As the bus, I want a plain-text message to be checked
against any pending follow-up for its sender before falling through to
normal agent routing.

**Acceptance criteria:**
1. In `src/http/api.ts`'s `processInbound`, add a check before the existing
   `if (result.isSlashCommand && ...)` block: when `!result.isSlashCommand`
   and `result.envelope.payload.type === 'text'`, call
   `deps.commandRegistry.consumeFollowUp(channel, sender)`.
2. If it returns non-null and `validate(body)` is true: look up the target
   command via `commandRegistry.lookup(command)`, invoke
   `cmd.handler([body.trim()], cmdCtx)` (same `cmdCtx` shape already built
   for the existing bus-command path), send the response via the
   originating adapter, log the outbound transcript
   (`command_response: true, command`), and `return { ok: true, queued:
   false, reason: 'command_handled' }` — identical outcome shape to a
   normal bus-command invocation.
3. **Refactor**: extract the existing "send response via originAdapter +
   log outbound transcript" block (currently inline in the slash-command
   dispatch branch, `src/http/api.ts:305-345`ish) into a small shared
   helper (e.g. `sendCommandResponse(deps, envelope, commandName,
   responseBody)`) used by *both* the normal slash-command path and this
   new follow-up path — no duplicated send/log logic.
4. If `consumeFollowUp` returns non-null but `validate(body)` is false, do
   nothing further here (the entry is already consumed by
   `consumeFollowUp`) — fall through to the rest of `processInbound`
   unchanged, exactly as if no follow-up had ever been registered.
5. Tests: a registered follow-up + matching next message short-circuits to
   `command_handled` and never reaches the fan-out/enqueue step; a
   registered follow-up + non-matching next message proceeds to normal
   enqueue/fan-out; no follow-up registered → unchanged existing behavior
   (regression coverage for the untouched path).

**Complexity:** M

### S36.3 — `/torrent` no-arg prompt + capture registration

**User story:** As Chris, I want `/torrent` with no argument to ask for the
magnet link instead of erroring, and have my next message just work if it's
a magnet link.

**Acceptance criteria:**
1. In `src/index.ts`, the `/torrent` handler's no-magnet branch changes
   from returning the usage-error body to: call
   `commandRegistry.registerFollowUp(context.channel, context.sender,
   'torrent', (body) => body.trim().startsWith('magnet:'), 10 * 60 *
   1000)` (10-minute TTL) and return `{ body: "What's the magnet link?
   🧲" }`.
2. The existing `/torrent <magnet-link>` direct-argument path is untouched
   — this only changes the no-argument branch.
3. `commandRegistry` is already in closure scope at the `/torrent`
   registration site (`createCommandSystem` returns it just above) — no
   new parameter threading needed.
4. Manual/integration test: `/torrent` → reply is the prompt; sending a
   bare `magnet:...` next → download starts, same success message as
   today's direct-argument path, and the message never shows up as a
   normal turn to Peggy.

**Complexity:** S

### S36.4 — Tests, docs

**User story:** As a maintainer, I want this documented so the mechanism
(and why `/torrent` uses it) is discoverable.

**Acceptance criteria:**
1. `docs/SLASH_COMMANDS.md` gets a short note on `/torrent`'s two forms
   (direct argument, and no-arg prompt-and-capture) and a brief mention of
   the underlying follow-up-capture mechanism for future command authors.
2. `CHANGELOG.md` entry under `[Unreleased]`.
3. Full existing test suite + `tsc --noEmit` still pass (the refactor in
   S36.2 touches shared code on the existing slash-command path — needs
   explicit regression coverage, not just new-path coverage).

**Complexity:** S

### S36.5 — `/torrent` completion notification

**User story:** As Chris, I want to be told when my torrent download
finishes (or fails), instead of having to ask or check logs myself.

**Acceptance criteria:**
1. In `src/index.ts`'s `/torrent` handler, capture a reference to
   `context.channel`, `context.sender`, and the resolved contact id
   (stripping the `contact:` prefix, matching the existing pattern in
   `api.ts`'s command-response block) at spawn time, in the closure passed
   to `child.on('exit', ...)`.
2. Attach the `'exit'` listener *before* calling `child.unref()` — order
   matters for readability/correctness clarity even though `unref()`
   itself doesn't suppress the listener.
3. On exit with code `0`: resolve `conversation_id`/`session_id` via
   `resolveConversationForOutbound(db, contactId, channel)`
   (`src/pipeline/outbound-transcript.ts`), look up the adapter via
   `registry.lookupPrimaryByChannel(channel)`, build a system-originated
   envelope (`sender: 'system:bus'`, `recipient` = the original sender,
   `topic` = the original invocation's topic) with a success body (e.g.
   `📚 Torrent download complete — check iCloud Books!`), `adapter.send(...)`,
   then `logOutboundTranscript(db, { ..., metadata: { command_response:
   true, command: 'torrent', torrent_notification: true } })` — mirrors the
   existing command-response send+log block in `api.ts` exactly (extract a
   shared helper if that block was already pulled out for S36.2, otherwise
   a small local duplicate is acceptable given it's a different call site
   with a different trigger, not the same code path).
4. On exit with a non-zero code: same send/log mechanics, but with a
   distinct failure body (e.g. `⚠️ Torrent download failed (exit code
   {code}) — check logs/torrents/ for details`) rather than the success
   message.
5. If the adapter lookup or conversation/session resolution fails (e.g. the
   channel no longer has an active adapter), log a `console.warn` and don't
   throw — a failed *notification* must never crash bus-core or affect
   anything else, since it runs fully detached from any request/response
   cycle.
6. Test: mock/fake the spawned child's exit event for both success and
   failure codes, assert the correct message body is sent to the correct
   channel/recipient and a matching outbound transcript row is written;
   assert a missing-adapter case logs a warning and doesn't throw.

**Complexity:** S

---

## Notes

- **Why single-shot, not a sticky "keep listening" mode.** Chris's own
  phrasing — "routes there instead of you if the **next** message is a
  magnet link only" — is explicitly about the one immediately-following
  message, not an open-ended listening state. Single-shot consumption also
  avoids a whole class of bugs (a stale capture firing on an unrelated
  message sent hours later, or two different in-flight captures for the
  same sender racing) that a longer-lived "awaiting input" mode would
  need to solve for no real benefit here.
- **Why a generic primitive on `CommandRegistry` rather than something
  `/torrent`-specific.** The capture/consume/validate shape costs almost
  nothing extra to make generic (command name + a validator closure,
  not hardcoded field names), and there's an obvious second use case
  already in the same file (any future command wanting a "what's the
  value?" prompt-and-capture flow) — cheap optionality, not speculative
  over-engineering.
- **Why the fun-but-real 🧲 only in the prompt, not mandated elsewhere.**
  Chris's ask was specifically about the prompt message. Adding it to the
  success/download-started response too would be a harmless, low-risk
  extra touch — left as an easy follow-up for whoever implements this, not
  a hard requirement.
- **Interaction with per-contact serialization**: `HeadlessInstance.enqueue()`
  already serializes turns per contact, so there's no realistic race where
  two messages from the same sender are being processed by `processInbound`
  concurrently — `consumeFollowUp`'s single-shot delete-on-read is safe
  without additional locking.
