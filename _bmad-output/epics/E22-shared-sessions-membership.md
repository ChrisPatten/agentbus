# E22 — Shared Sessions & Conversation Membership (multi-participant email)

| Field | Value |
|---|---|
| Epic ID | E22 |
| Dependencies | E21 (email channel — first consumer), E20 (journaling memory model, long-lived per-`conversation_id` sessions), E19 (headless adapter — generates replies) |
| Story Count | 4 |
| Estimated Complexity | L |

---

## Epic Summary

Today every AgentBus session is **1:1**: `conversation_id =
sha256(sorted([contact_id, channel, topic]))` (`route-resolve.ts:34`) folds the
sender into the key, so two people on one email thread fork into two separate
sessions and the agent answering one can't see what the other said. Outbound is
1:1 too — a thread stores a single `contact_address` and replies go only there.

E22 introduces a **conversation-membership model**: a session has a set of member
contacts, inbound is admitted only for members, and any member can add another
member (on email, by Cc'ing them). Email is the first adapter to populate it, but
the model is **adapter-agnostic** so a future Telegram/Slack group adapter rides
the same machinery — it just sets a capability flag and supplies its own member
list.

Scope decision (locked with product): **build the general model, wire email first.**
The Telegram group adapter that would prove the abstraction end-to-end is explicitly
deferred (see S22.4, not in this epic's delivery).

Four pillars:

1. **Membership as data** — a `conversation_members` table is the authoritative
   "who is in this session," with `added_by` provenance. Email seeds it from a
   thread's resolved From/To/Cc participants.

2. **Shared-session keying** — a new adapter capability `sharedSession: true`. When
   set, `route-resolve` keys `conversation_id` on `[channel, topic]` alone (drops
   `contact_id`), so an entire thread is **one** long-lived session. 1:1 DM
   adapters don't set the flag and are completely unaffected.

3. **The admission rule** (access control) — a pipeline stage enforces: a brand-new
   topic creates a session with the sender as founding member; an existing session
   admits a sender **only if they are a member**; a member's message that names
   other known contacts (email Cc) **adds** them as members (`added_by = sender`).
   This is trust model **B (thread TOFU)**: the permitted participant set is bounded
   by who an authenticated, allowlisted member already put on the thread.

4. **Reply-all from the member set** — the email adapter persists the full
   participant set per thread and sends to `To`/`Cc` = members − agent. On a
   shared-session thread **reply-all is the default**; `reply` / `send_email` gain a
   `reply_to_sender` flag to deliberately narrow a single reply to just the
   triggering sender. Because the outbound set is exactly the current members,
   reply-all can never reach anyone a member didn't add.

**Memory stays agent-driven.** Per product direction, E22 does **not** build
per-contact memory partitioning or memory ACLs. The single obligation to the agent
is always-present, structured context of *who is in this session and who sent each
message*, so the agent can exercise judgment about what it says and what it stores.
That participant context (S22.2) is therefore the primary control surface, not a
nicety.

---

## Entry Criteria

- E21 complete: email adapter delivers inbound via `processInbound()`, threads map
  to `thread:<hash>` topics, `contact-resolve` maps email addresses → contacts.
- `route-resolve` (Stage 70) computes `conversation_id` from
  `[contact_id, channel, topic]`; `contact-resolve` (Stage 20) runs before it.

---

## Exit Criteria

1. With `sharedSession` set on the email adapter, two **different** allowlisted
   contacts replying to the **same** thread resolve to the **same**
   `conversation_id` → one shared session. Each inbound is attributed to its sender
   in the agent's view.
2. A member's inbound mail that Cc's another known contact adds that contact to
   `conversation_members` (`added_by` = the sender). A subsequent reply from the
   newly-added contact is admitted into the shared session.
3. An inbound message whose sender is **not** a member of an existing shared session
   is **not** routed into it (admission denied, logged). New topics always create a
   session with the sender as founding member.
4. On a shared-session thread `reply` / `send_email` default to **reply-all** —
   all current thread members (minus the agent) as `To`/`Cc`; passing
   `reply_to_sender` narrows to only the triggering sender. No address outside the
   member set is ever contacted.
5. 1:1 adapters (Telegram, BlueBubbles) are byte-for-byte unaffected:
   `conversation_id` and routing unchanged when `sharedSession` is not set.
6. `tsc --noEmit` clean; unit tests cover the keying branch, the admission rule
   (founding member / member-admit / non-member-deny / Cc-add), participant
   capture+resolution, and reply-all address assembly.
7. Docs updated: `docs/SESSION_MODEL.md` (new — membership + admission + shared
   keying), `docs/EMAIL_ADAPTER.md` (participants, reply-all, trust model B),
   `docs/MCP_TOOLS.md` (`reply_all`), CHANGELOG.

---

## Data Model

```sql
-- Authoritative member set per shared session.
CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL,
  contact_id      TEXT NOT NULL,
  added_by        TEXT,            -- contact_id who added them; NULL = founding member
  added_at        TEXT NOT NULL,
  source          TEXT,            -- 'founder' | 'cc' | 'manual' (provenance)
  PRIMARY KEY (conversation_id, contact_id)
);
```

The email adapter additionally persists the thread's participant **addresses**
(extending `email_threads`, e.g. a `participants` JSON column) so `send()` can build
`To`/`Cc` without re-resolving contacts. `conversation_members` is the access-control
truth; the email `participants` set is the delivery detail.

---

## Stories

### S22.1 — Membership model + shared-session keying + admission rule

**User story:** As the bus, I want a conversation to have an enforced member set and
(for group-capable channels) one session per topic, so multiple people can share a
thread without strangers reaching it.

**Acceptance criteria:**
1. New `conversation_members` table + a small DAO (add member, list members, is-member).
2. New adapter capability `sharedSession?: boolean` on `AdapterCapabilities`; the
   email adapter sets it `true`. `route-resolve` keys `conversation_id` on
   `[channel, topic]` when the originating adapter is shared-session, else the
   existing `[contact_id, channel, topic]`. (The stage learns the flag via the
   registry / a config-derived set of shared-session channels.)
3. New admission stage (or extension of route-resolve) enforces, for shared-session
   channels: new topic → create session + sender is founding member
   (`source='founder'`); existing session + sender is a member → admit; existing
   session + sender **not** a member → deny (return null / drop, logged).
4. Non-shared-session channels bypass all of the above — identical behavior to today.

**Complexity:** L

### S22.2 — Inbound participant capture, resolution & surfacing

**User story:** As the agent, I want to know everyone on the chain and who sent each
message so I can exercise judgment about what I say and store.

**Acceptance criteria:**
1. The email adapter captures `From`, `To`, and `Cc` (all addresses, not `[0]`) and
   resolves each via the contact map; known → `contact:<id>`, unknown → raw address.
2. A member's inbound message that names other **known** contacts (To/Cc) adds them
   to `conversation_members` with `added_by` = the sender and `source='cc'` (trust
   model B). Participant addresses are persisted on the thread row.
3. The agent's message view surfaces the participant set, e.g.
   `New message from contact:chris (To: you; Cc: contact:alice, bob@vendor.com) via email`
   (`cc.ts` message formatting), so the shared-session context is explicit.
4. Tests: multi-recipient parse, Cc-driven membership growth, mixed known/unknown
   resolution, participant surfacing.

**Complexity:** M

### S22.3 — Reply-all from the member set

**User story:** As a user on a group thread, I want the agent's reply to reach
everyone on the thread (and only them).

**Acceptance criteria:**
1. `send(envelope)` for a shared-session thread builds `To`/`Cc` from the persisted
   participant addresses minus the agent's own address.
2. `reply` and `send_email` accept `reply_to_sender?: boolean`. Default (omitted) on
   a shared-session thread: reply-all to all current members. With it: reply only to
   the triggering sender.
3. The outbound recipient set is intersected with the thread's member/participant set
   — no address outside it is ever contacted (reply-all cannot widen the audience
   beyond trust model B's bound).
4. Tests: reply-all address assembly (self excluded) as the default,
   `reply_to_sender` narrowing, refusal to send outside the member set.

**Complexity:** M

---

### S22.4 — Group adapter to validate the abstraction (deferred — not in this epic)

**User story:** As a maintainer, I want a real group adapter (e.g. Telegram group
chat) that sets `sharedSession` and supplies its own member list, proving the model
generalizes beyond email.

**Status:** Deferred per scope decision. Captured here so the seam built in
S22.1–S22.3 stays adapter-agnostic. Pulled into its own epic when a group adapter is
actually scheduled.

**Complexity:** L

---

## Notes

- **Why a capability flag, not a global keying change.** Keying *all* channels on
  `[channel, topic]` would silently merge 1:1 DM sessions that happen to share a
  topic. The `sharedSession` opt-in keeps the blast radius to email now and is the
  exact seam a future group adapter flips — the generalization without the risk.
- **Admission for email is defense-in-depth; for group adapters it's the enforcement.**
  Email thread keys derive from unguessable `Message-ID`s and inbound is already
  gated by allowlist + DKIM, so a non-member can't realistically land on an existing
  thread. The admission rule still matters: it's the actual access control for
  group adapters where a room id may be guessable, and it's the single place the
  "members only, members can add members" invariant lives.
- **Trust model B, restated.** The permitted participant set of a session is exactly
  the contacts an authenticated, allowlisted member has put on the thread. The agent
  cannot email a stranger; a member vouches for new participants by Cc'ing them.
- **Memory is intentionally untouched.** With agent-owned memory, partitioning is the
  agent's judgment call. E22's job is to give it unambiguous who's-here / who-said-this
  context (S22.2), not to build ACLs around storage.
- **Migration.** Existing email conversations were keyed with `contact_id`; after the
  keying change, in-flight single-person threads re-key to `[channel, topic]` and
  continue as a fresh (still single-member) shared session. Acceptable pre-1.0; note
  in CHANGELOG as a behavior change.
