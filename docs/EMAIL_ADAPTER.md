# Email Adapter

The email adapter (`src/adapters/email.ts`) is a platform adapter that bridges an
IMAP/SMTP mailbox and the AgentBus bus-core. It runs in-process with bus-core and
is registered in the `AdapterRegistry` at startup. It is the channel E20's
long-lived, per-`conversation_id` session model was designed to enable: **each
email thread becomes its own long-lived session**, so the agent picks up a thread
exactly where it left off.

---

## Architecture

```
IMAP server  ──IDLE (push)──>  EmailAdapter (in bus-core)  ──processInbound──>  pipeline / queue
SMTP server  <──sendMail────  EmailAdapter                <──send(envelope)──   delivery worker
```

The adapter class implements `AdapterInstance` and provides:

- **Inbound (IMAP IDLE)** — keeps an IMAP connection open and uses IDLE so new
  mail is picked up near-instantly. Each message is parsed, checked against the
  sender allowlist and an authentication (anti-spoofing) check, mapped to a stable
  per-thread topic, and submitted to the pipeline via `processInbound()` (no HTTP
  hop). The connection is supervised: an unexpected drop reconnects with backoff.
- **`send(envelope)`** — called by the delivery worker. Looks the thread up by
  `(channel, topic)` and sends a properly-threaded SMTP reply (`In-Reply-To`,
  `References`, `Re:` subject, original `To`).

Like the Telegram adapter, it receives infrastructure dependencies (config,
pipeline, queue, db) via constructor injection and does **not** talk to bus-core
over HTTP.

---

## Configuration

Defaults target **iCloud**. Set `host`/`port` to use any provider (Fastmail,
Gmail, self-hosted, …).

### Single account

Adapter id `email`, channel `email`:

```yaml
adapters:
  email:
    imap:
      host: imap.mail.me.com      # default (iCloud)
      port: 993                   # default (implicit TLS)
      user: peggy@icloud.com
      password: ${ICLOUD_APP_PW}  # app-specific password — NOT the Apple ID password
      mailbox: INBOX              # default
    smtp:
      host: smtp.mail.me.com      # default (iCloud)
      port: 587                   # default (STARTTLS)
      user: peggy@icloud.com      # defaults to imap.user
      password: ${ICLOUD_APP_PW}  # defaults to imap.password
      from: Peggy <peggy@icloud.com>   # defaults to imap.user
    require_auth: true            # default — drop SPF/DKIM/DMARC failures
```

### Multiple accounts

Use a named record. Each key becomes an adapter id `email:<name>` and a channel
`email:<name>`:

```yaml
adapters:
  email:
    peggy:
      imap: { user: peggy@icloud.com, password: ${ICLOUD_APP_PW_PEGGY} }
    work:
      imap: { host: imap.fastmail.com, user: me@work.com, password: ${FASTMAIL_PW} }
```

Each instance runs its own IMAP connection and SMTP transport. Configuring the
same mailbox twice is rejected at startup.

### iCloud setup

1. Enable two-factor authentication on your Apple ID.
2. Generate an **app-specific password** at <https://account.apple.com> → Sign-In
   and Security → App-Specific Passwords. iCloud rejects your normal password over
   IMAP/SMTP.
3. Use `imap.mail.me.com:993` and `smtp.mail.me.com:587` (the defaults).

---

## Identity & anti-spoofing

Two independent gates protect the agent's inbox:

1. **Allowlist.** A sender only reaches the agent if its address is listed under a
   contact's `platforms.email.address` (string or list, matched case-insensitively).
   `contact-resolve` rewrites the sender to `contact:<id>`. Unknown senders are
   dropped and logged.

   ```yaml
   contacts:
     chris:
       id: chris
       displayName: Chris
       platforms:
         email:
           address:
             - chris@example.com
             - chris@work.com
   ```

2. **Authentication (`require_auth`, default `true`).** A `From:` header is trivial
   to forge, so the adapter also requires the message to be authenticated for its
   From domain. It checks two layers, cheapest first:

   1. **`Authentication-Results` header** (fast path) — if the receiving server
      stamped one (Gmail and most external providers do), trust it when it shows
      `dmarc=pass`, or `dkim=pass` with `header.d` aligned to the From domain, or
      `spf=pass` with `smtp.mailfrom` aligned.
   2. **DKIM verification against DNS** (fallback) — if no usable header is
      present, the adapter verifies the message's own `DKIM-Signature` against the
      signing domain's public key (via [`mailauth`](https://github.com/postalsys/mailauth))
      and requires at least one signature to **pass and align** with the From
      domain.

   Anything that satisfies neither layer is dropped. This defeats a spoofed
   `From:` on an allowlisted address.

> **Why the DKIM fallback matters (iCloud):** for **intra-iCloud** delivery
> (iCloud → iCloud) Apple does **not** add an `Authentication-Results` header at
> all — but the mail is still DKIM-signed (`d=icloud.com`). Layer 1 finds nothing,
> so layer 2 verifies the DKIM signature directly and the message is accepted.
> Without the DKIM fallback, all iCloud-to-iCloud mail would be dropped.
>
> Note: Apple signs everything as `d=icloud.com`. If you send **from an `@me.com`
> or `@mac.com` alias**, the signature won't align with that From domain and the
> message is rejected under `require_auth: true`. Send from the `@icloud.com`
> address, or set `require_auth: false` (the allowlist still gates senders).
>
> The DKIM fallback needs outbound DNS (TXT lookups). Set `require_auth: false`
> only for trusted internal relays where neither layer applies.

---

## Threading & sessions

Each email **thread** maps to its own long-lived session. The adapter derives a
stable **thread key** from the message headers:

1. the root id of the `References` header (the originating message), else
2. the `In-Reply-To` id, else
3. the message's own `Message-ID` (a brand-new thread).

The thread key is hashed into a reserved topic `thread:<hash>`. Because
`conversation_id = sha256(sorted([contact_id, channel, topic]))`, every message in
a thread resolves to the **same** `conversation_id` → the same session, while a
different thread gets a different one. The headless adapter resumes one
`claude_session_id` per `conversation_id` (see
[CC_HEADLESS_ADAPTER.md](./CC_HEADLESS_ADAPTER.md) and
[MEMORY_MODEL.md](./MEMORY_MODEL.md)).

- **A reply** carries the thread's `References`, so it lands on the existing
  session.
- **A forward** is a fresh compose with no `References`/`In-Reply-To`, so its
  thread key is its own `Message-ID` → a new `conversation_id` → a new session.
  Branching is automatic; no special-casing.

Two pipeline stages cooperate with the reserved prefix (`THREAD_TOPIC_PREFIX` in
`src/pipeline/types.ts`):

- `topic-classify` preserves any `thread:`-prefixed topic verbatim (it is not a
  configured topic label, so it would otherwise be reset to `general`).
- `priority-score` does **not** award the non-general topic bonus for a `thread:`
  topic — it's a routing key, not a classification.

### Reply threading state

Per-thread reply metadata is persisted in the `email_threads` table (migration
010), keyed by `(channel, topic)`:

| column | purpose |
|---|---|
| `thread_key` | the derived thread root id |
| `subject` | base subject (for the `Re:` reply) |
| `last_inbound_message_id` | becomes the reply's `In-Reply-To` |
| `references_chain` | becomes the reply's `References` |
| `contact_address` | the `To:` we reply to (the address they wrote from) |

`send(envelope)` reads this row to build a correctly-threaded reply and appends its
own outbound `Message-ID` to the chain.

---

## Agent-initiated email (`send_email` tool)

Replies thread into a message the agent **received**. To reach out **proactively**
(start a fresh thread), the agent calls the `send_email` MCP tool, registered
whenever an email adapter is configured (see [MCP_TOOLS.md](./MCP_TOOLS.md)).

- It sends on the **first** configured email channel (`email`, or `email:<name>`).
- `to` defaults to the **first** allowlisted address (the
  `contacts[*].platforms.email.address` values, in config order). An explicit `to`
  is accepted only if it is on that allowlist (case-insensitive); anything else is
  rejected and **nothing is sent**.
- The envelope is routed to the owning `contact:<id>` (the delivery worker only
  dispatches `contact:`-prefixed recipients), with the exact target address carried
  in `metadata.email_to`.
- There is no `email_threads` row for an agent-initiated message, so `send()` takes
  the no-thread path: it sends to `metadata.email_to` (re-checked against the
  allowlist as defense in depth). So even a malformed envelope cannot deliver to an
  off-allowlist recipient.
- The subject is the tool's optional `subject` (carried in `metadata.email_subject`),
  falling back to *Message from your assistant* when omitted.

This is the same allowlist the inbound path enforces — the agent can never email an
arbitrary recipient.

---

## Response length (channel-aware verbosity)

"Longer, more thorough" email replies are a **system-prompt** concern, not adapter
logic. The agent already receives `{{channel}}` in its prompt context, so the
recommended `cc-headless.system_prompt` instructs it to adapt:

```
Match your length and formality to the channel:
  - telegram*: reply briefly and conversationally (1–3 sentences).
  - email*:    write a complete, well-structured reply — a greeting, your full
               reasoning in clear sections, and a sign-off. Take the space email
               affords; this is not a chat message.
```

The adapter imposes no length cap and never splits outbound mail.

### Inbound body: replies vs. forwards

What the agent receives as the message body depends on whether the mail is a
**threaded reply** or a **forward / new thread**.

**Classification.** A message is treated as a forward when its subject is `Fwd:`/`Fw:`
or its body carries a forwarded-message marker (`Begin forwarded message:` /
`---------- Forwarded message ----------`). This overrides any `References` a
forwarding client might carry, so a forward is never mistaken for a reply. Otherwise,
a message with `In-Reply-To`/`References` is a threaded reply; anything else is a new
thread. Forwards are tagged `metadata.email_is_forward`.

**Body text (`resolveInboundText` → `selectInboundBody`).**

- **Threaded reply** — uses the `text/plain` part and **strips the quoted history**
  (the `On … wrote:` / `>` / `-----Original Message-----` tail). Those earlier turns
  already live in the thread's long-lived session, so re-feeding the quoted chain
  every message would just burn context. **So no — the agent does not get the full
  quoted chain on each reply; it gets only the new text.** (If a reply's text part is
  blank, the HTML is converted as a fallback.)
- **Forward / new thread** — **prefers the HTML conversion** (`htmlToPlainText`, via
  `html-to-text`) and keeps the **full body**. This is essential for forwards: a
  client forwarding an HTML email commonly emits a `text/plain` part that contains
  the user's note + the forward header block but an **empty forwarded body**, while
  the real payload lives only in the HTML. Reading the text part alone would deliver
  the note and `Begin forwarded message:` marker with nothing after it. In the HTML
  conversion, links become `text [url]`, images are dropped, and tables render as
  aligned text.

(For a message with *only* an HTML part, mailparser derives the text itself, so that
path works too.) The `[Email with no text body]` placeholder now appears only when a
message has neither a usable text part nor an HTML part (e.g. attachment-only). The
agent reads the **text** rendering, not the original HTML markup — fine for reasoning
over the content, though visual table structure is flattened to aligned text.

---

## Rich-text rendering

Outbound mail is sent **`multipart/alternative`**: the agent writes **Markdown**,
which `src/adapters/email-render.ts` (`renderEmail`) renders to a styled HTML part,
with the original Markdown kept as the plain-text alternative (clients that prefer
`text/plain` get a clean, readable fallback for free).

What renders:

- **Tables** (GFM) — bordered cells, a shaded/bold header row, zebra-striped body
  rows, wrapped in a horizontally-scrollable box so wide tables don't blow out a
  phone screen.
- Headings, paragraphs, ordered/unordered lists, blockquotes, horizontal rules.
- **Inline code** and fenced **code blocks** (monospace, shaded, scrollable).
- Links (auto-linked too), opened with `target=_blank` + `rel=noopener noreferrer`.

How it renders well everywhere:

- **Inline styles on every element.** Most clients (notably Gmail) strip
  `<head>`/`<style>`, so all visual styling lives on the element's `style` attribute.
- A small `<style>` block carries the two things that can only be media queries:
  **dark mode** (`prefers-color-scheme: dark`) and **mobile** padding
  (`max-width: 600px`). Clients that drop it still get the correct light-mode layout.
- Responsive `<meta viewport>`, `color-scheme` hints, system font stacks, a
  centered max-width card, and `x-apple-disable-message-reformatting` (so Apple Mail
  doesn't auto-rescale).

**Safety.** The renderer runs markdown-it with `html: false`, so any raw HTML in the
agent's text is **escaped**, not rendered — there is no HTML-injection surface and no
sanitizer dependency is needed.

The agent only needs to know it *may* use Markdown — that's a system-prompt note
(e.g. *"email supports Markdown: headings, tables, lists, and code blocks render as
formatted text"*). No flag toggles it; plain prose still renders fine.

---

## Routing

Route the email channel to whichever agent should answer (typically the headless
adapter, so it can reply in-thread):

```yaml
pipeline:
  routes:
    - match: { channel: email }          # or email:peggy for a named instance
      target: { adapterId: cc-headless, recipientId: agent:claude }
```

You'll usually want a longer journaling threshold for email than for chat, since
email conversations move slowly:

```yaml
adapters:
  cc-headless:
    journaling:
      threshold_ms:
        telegram: 1800000   # 30 min
        email: 86400000     # 24 h
        default: 1800000
```

---

## Capabilities

| Capability | Email |
|---|---|
| `send` | ✅ |
| `react` | ❌ |
| `typing` | ❌ (email has no typing indicator; the headless/poll adapters skip the typing call for `email`/`email:*` channels) |
| `markRead` | ❌ |
| `registerCommands` | ❌ |
| `maxMessageLength` | effectively unlimited (never split) |

---

## Limitations

- **Outbound is rich text (Markdown → HTML); inbound is read as text.** Outbound mail
  is sent `multipart/alternative` with an HTML part (see *Rich-text rendering*).
  Inbound HTML mail is down-converted to text by `mailparser`, so the agent reads the
  text rendering (visual structure like tables is flattened); a placeholder body
  appears only when a message has no text *and* no HTML part. Inbound file
  attachments **are** downloaded (see [ATTACHMENTS.md](./ATTACHMENTS.md));
  outbound attachments are out of scope.
- **Trust the receiving server.** The anti-spoof check relies on the mailbox
  server's `Authentication-Results` header.
- **One mailbox per instance.** Watching multiple folders requires multiple
  instances.

---

## Related

- [CC_HEADLESS_ADAPTER.md](./CC_HEADLESS_ADAPTER.md) — generates the replies; resumes one session per `conversation_id`.
- [MEMORY_MODEL.md](./MEMORY_MODEL.md) — cross-channel continuity via the agent's own files.
- [TELEGRAM_ADAPTER.md](./TELEGRAM_ADAPTER.md) — the adapter this one is modeled on.
- Epic: `_bmad-output/epics/E21-email-channel.md`.
