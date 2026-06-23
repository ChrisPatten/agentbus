# E21 — Email Channel (IMAP IDLE + SMTP)

| Field | Value |
|---|---|
| Epic ID | E21 |
| Dependencies | E20 (journaling memory model, long-lived per-`conversation_id` sessions), E19 (headless adapter — generates the replies), E17 (per-agent media — pattern reuse) |
| Story Count | 6 |
| Estimated Complexity | L |

---

## Epic Summary

AgentBus speaks to its agent over messaging channels (Telegram today). E21 adds
**email** as a first-class channel so the same agent can hold long-form, threaded
email conversations. Email is the channel E20 was explicitly designed to enable:
per-thread sessions already "fall out" of the `conversation_id =
sha256(sorted([contact_id, channel, topic]))` keying, and `claude -p` already
resumes one session per `conversation_id`. E21 supplies the missing pieces:

1. **A platform adapter** (`email.ts`) that receives mail over **IMAP IDLE**
   (push) and sends replies over **SMTP**, defaulting to iCloud's servers. It runs
   in-process and implements `AdapterInstance` exactly like the Telegram adapter,
   submitting inbound mail to the shared pipeline via `processInbound()` and
   sending outbound replies from the delivery worker's `send()` call.

2. **Per-thread identity** — each email thread maps to its own long-lived session.
   The adapter derives a stable **thread key** from the message's `References` /
   `In-Reply-To` headers (the thread root), hashes it into a `thread:<hash>`
   topic, and persists the thread's reply metadata so a generated reply threads
   correctly (`In-Reply-To`, `References`, `Re:` subject, original `To`). A
   **forward** has no `References` chain, so it naturally becomes a new thread →
   new `conversation_id` → new session.

3. **Trusted identity** — a sender allowlist maps email addresses to known
   contacts (`contacts[*].platforms.email`), and, by default, inbound mail must
   pass an `Authentication-Results` (SPF/DKIM/DMARC) check so a spoofed `From:`
   on an allowlisted address is rejected.

4. **Channel-aware verbosity** — "longer, more thorough" email replies are a
   **system-prompt** concern, not adapter logic. The agent already receives
   `{{channel}}`; the recommended prompt instructs it to be terse on Telegram and
   thorough/structured (greeting, full reasoning, sign-off) on email. No renderer
   change is required.

5. **Multi-account** — multiple mailboxes are configured as multiple named adapter
   instances (`email:peggy`, `email:work`), mirroring the Telegram named-record
   multi-instance form.

---

## Entry Criteria

- E20 complete: long-lived sessions keyed on `conversation_id`; headless adapter
  resumes one `claude_session_id` per conversation; journaling threshold supports
  per-channel values (already documents an `email: 86400000` example).
- Pipeline computes `conversation_id` from `[contact_id, channel, topic]` in
  Stage 70 (route-resolve).

---

## Exit Criteria

1. With an `email:<name>` adapter configured, inbound mail from an allowlisted,
   authenticated sender is delivered to the agent and a reply is sent back into
   the **same** mail thread (correct `In-Reply-To`/`References`/`Re:` subject).
2. Two distinct threads from the same contact resolve to two distinct
   `conversation_id`s → two independent long-lived sessions. A forward starts a
   third.
3. Mail from an unknown sender, or from an allowlisted address that fails
   `Authentication-Results` (when `require_auth: true`), is dropped and logged;
   nothing reaches the agent.
4. Multiple `email:*` instances run concurrently, each bound to its own mailbox.
5. `tsc --noEmit` clean; unit tests cover thread-key derivation, auth-results
   parsing, topic hashing, `getEmailInstances()`, and the contact-resolve email
   branch.
6. `docs/EMAIL_ADAPTER.md` documents setup (iCloud app password), threading,
   anti-spoof, and the recommended channel-aware system prompt.

---

## Config Shape

```yaml
adapters:
  # Named-record form → adapter ids "email:peggy", "email:work".
  email:
    peggy:
      imap:
        host: imap.mail.me.com      # iCloud default
        port: 993                   # default 993 (implicit TLS)
        user: peggy@icloud.com
        password: ${ICLOUD_APP_PW_PEGGY}   # iCloud app-specific password
        mailbox: INBOX              # default INBOX
      smtp:
        host: smtp.mail.me.com      # iCloud default
        port: 587                   # default 587 (STARTTLS)
        user: peggy@icloud.com      # default: imap.user
        password: ${ICLOUD_APP_PW_PEGGY}   # default: imap.password
        from: Peggy <peggy@icloud.com>     # default: imap.user
      require_auth: true            # default true — drop SPF/DKIM/DMARC failures

contacts:
  chris:
    id: chris
    displayName: Chris
    platforms:
      email:
        address: chris@example.com  # string or list — the allowlist

pipeline:
  routes:
    - match: { channel: email:peggy }
      target: { adapterId: cc-headless, recipientId: agent:peggy }

memory:
  # E20 journaling threshold — email conversations move slower than chat.
  # (cc-headless.journaling.threshold_ms)
```

Recommended channel-aware system prompt fragment (cc-headless `system_prompt`):

```
You are {{contact_id}}'s assistant, reached on {{channel}}.
- On telegram*: reply briefly and conversationally (1–3 sentences).
- On email*: write a complete, well-structured reply — greeting, full
  reasoning with clear sections, and a sign-off. Take the space email affords.
```

---

## Stories

### S21.1 — Email adapter config schema & multi-instance

**User story:** As an operator, I want to configure one or more email mailboxes so
that the agent can send and receive mail per account.

**Acceptance criteria:**
1. `EmailAdapterSchema` validates `imap` (host, port=993, user, password,
   mailbox=INBOX), `smtp` (host, port=587, user/password/from defaulting to the
   IMAP values), and `require_auth` (default true).
2. `adapters.email` accepts a single-instance object or a named record, like
   Telegram. `getEmailInstances(config)` normalizes both into a flat list with
   `name`, throwing on duplicate accounts / invalid instance names.
3. `contacts[*].platforms.email.address` accepts a string or string array.

**Complexity:** S

### S21.2 — Thread-key derivation & topic mapping

**User story:** As the bus, I want each email thread to map to a stable topic so
that per-thread sessions form automatically.

**Acceptance criteria:**
1. Pure helper derives a thread key: root id of `References`, else `In-Reply-To`,
   else the message's own `Message-ID`.
2. Topic = `thread:` + short stable hash of the thread key.
3. `topic-classify` preserves any `thread:`-prefixed topic; `priority-score` does
   not award the non-general `topic_bonus` for `thread:` topics.

**Complexity:** M

### S21.3 — IMAP IDLE inbound

**User story:** As a user, I want mail I send to be picked up promptly so the
agent can respond.

**Acceptance criteria:**
1. Adapter connects over IMAP, opens the mailbox, and uses IDLE to receive new
   mail near-instantly, with reconnect/backoff supervision (mirrors Telegram's
   supervised loop).
2. Each new message is parsed (from, subject, text body, threading headers,
   `Authentication-Results`) and submitted via `processInbound()` with
   `channel: email:<name>`, `sender: <from address>`, `topic: thread:<hash>`.
3. The thread's reply metadata (subject, last `Message-ID`, references chain,
   contact address) is upserted into `email_threads`.

**Complexity:** L

### S21.4 — Identity & anti-spoofing

**User story:** As an operator, I want only trusted, authenticated senders to
reach the agent so the inbox can't be used to impersonate me.

**Acceptance criteria:**
1. `contact-resolve` resolves an email sender to a contact via a `byEmailAddress`
   map; unknown senders get `platform:email:<addr>` and `ctx.contact = null`.
2. The adapter drops mail from non-allowlisted senders (logged).
3. With `require_auth: true`, mail whose `Authentication-Results` does not pass
   the SPF/DKIM/DMARC heuristic (or is absent) is dropped (logged).

**Complexity:** M

### S21.5 — SMTP threaded reply

**User story:** As a user, I want the agent's reply to land in the same email
thread.

**Acceptance criteria:**
1. `send(envelope)` looks up the thread by `(channel, topic)`, sends via SMTP with
   `In-Reply-To` = last inbound `Message-ID`, `References` = chain, subject =
   `Re: <subject>`, `To` = the contact's thread address, `From` = configured.
2. No splitting (email has no length cap); `maxMessageLength` is large/omitted.
3. Delivery failures return `{ success: false, retryable }` so the delivery
   worker handles them like any other adapter.

**Complexity:** M

### S21.6 — Wiring, docs, tests

**User story:** As a maintainer, I want the adapter wired into bus-core with docs
and tests.

**Acceptance criteria:**
1. `index.ts` registers each `getEmailInstances()` instance in the registry and
   starts it with the other adapters.
2. `docs/EMAIL_ADAPTER.md` + config example + CHANGELOG entry.
3. Unit tests green; `tsc --noEmit` clean.

**Complexity:** M

---

### S21.7 — Agent-initiated email + no typing indicator (follow-up)

**User story:** As the agent, I want to start a new email thread to the user, and I
don't want a (meaningless) typing indicator fired for email channels.

**Acceptance criteria:**
1. New `send_email` MCP tool: defaults `to` to the first allowlisted address,
   accepts an explicit allowlisted `to`, and rejects any non-allowlisted recipient
   (nothing sent). Registered whenever an email adapter is configured.
2. The email adapter re-enforces the allowlist when sending to a raw address
   (defense in depth).
3. The headless and polling CC adapters skip the `/typing` call for `email`/`email:*`
   channels.
4. Tests green; `tsc --noEmit` clean; `docs/MCP_TOOLS.md` + `docs/EMAIL_ADAPTER.md`
   + CHANGELOG updated.

**Complexity:** S

---

### S21.8 — Rich-text (Markdown → HTML) outbound (follow-up)

**User story:** As the user, I want the agent's emails formatted as rich text —
tables, lists, headings, code — rendered well on browser, desktop, and mobile.

**Acceptance criteria:**
1. Outbound mail is `multipart/alternative`: agent Markdown → styled HTML part, raw
   Markdown as the text fallback (`src/adapters/email-render.ts`, `markdown-it`).
2. GFM tables render with bordered cells, shaded/bold header, zebra body rows, and a
   horizontal-scroll wrapper for mobile; headings/lists/blockquotes/links/inline
   code/fenced code are styled.
3. Cross-client rendering: fully inlined element styles, with a `<style>` block only
   for dark-mode + mobile media queries; responsive viewport + `color-scheme` +
   `x-apple-disable-message-reformatting`.
4. Raw HTML in the agent body is escaped (`html: false`); no sanitizer needed.
5. Tests green; `tsc --noEmit` clean; `docs/EMAIL_ADAPTER.md` + `docs/MCP_TOOLS.md`
   + CHANGELOG updated.

**Complexity:** S

---

## Notes

- **Why a thread topic, not a new conversation_id formula.** Reusing the existing
  `[contact_id, channel, topic]` formula keeps route-resolve untouched and means
  email threading rides the exact same long-lived-session machinery E20 built for
  Telegram. The only cost is teaching `topic-classify` to leave a reserved
  `thread:` prefix alone.
- **Anti-spoof heuristic.** iCloud (and most providers) stamp an
  `Authentication-Results` header on delivered mail. The check requires a
  `dmarc=pass`, or failing that a `dkim=pass` / `spf=pass`, for the `From` domain.
  This is pragmatic, not a full DMARC-alignment engine; `require_auth: false`
  disables it for trusted/internal relays that don't stamp the header.
- **Forwards branch by design.** A forwarded mail is a fresh compose with no
  `References` chain, so its thread key is its own `Message-ID` → new
  `conversation_id` → new session. No special-casing needed.
- **Verbosity is prompt-shaped.** Per E20's notes, channel-aware formality is a
  system-prompt template concern enabled by the existing `channel` in
  `PromptContext`; E21 adds no renderer logic, only a documented recommended
  prompt.
