# Attachments

AgentBus supports **inbound images and documents** from Telegram and Email,
delivered to the Claude Code agent as file paths embedded in the channel
notification text. Outbound attachments and non-file types (video, audio,
stickers) are out of scope.

Both adapters share the same machinery (`src/media/attachments.ts`): per-agent
media config (`resolveMediaConfig`), safe extension derivation (`extensionFor`),
the `attachments` table, and the TTL sweeper. The only difference is the source
of the bytes — Telegram streams them from its Bot API, while Email already holds
them in memory (`mailparser`'s `attachment.content`) and writes them with
`persistAttachmentBuffer`.

## Config

Inbound image handling is configured per-agent, keyed by recipient id
(e.g. `agent:claude`). An agent with no `media` block will not receive
downloaded images — inbound images destined for that agent are silently
dropped with a warning.

```yaml
agents:
  "agent:claude":
    media:
      download_path: /tmp/agentbus/claude   # required; created at startup
      ttl_seconds: 3600                     # optional, default 3600 (1h)
```

- `download_path` — absolute directory where files are saved. Created
  recursively on bus startup if it does not exist.
- `ttl_seconds` — retention window in seconds. The attachment sweeper
  deletes files and their DB rows once `created_at + ttl_seconds` has
  passed. Must be a positive integer.

Multiple agents can each have their own download path and retention.

## Supported attachment types

| Telegram field | Attachment type | Notes |
|---|---|---|
| `photo[]` | `image` | Telegram-compressed; largest size selected |
| `document` with `image/*` MIME | `image` | Sent as original file (no compression) |
| `document` with any other MIME | `file` | PDFs, ZIPs, Office files, etc. |

## End-to-end flow

1. **Inbound update** — the Telegram adapter receives a message update
   containing `photo` (compressed) or a `document` of any MIME type.
2. **Target resolution** — the adapter walks `pipeline.routes` to find the
   first rule matching the inbound channel, reads `target.recipientId`,
   and looks up `agents[recipientId].media`. If no `media` is configured,
   a warning is logged and the message is delivered without the attachment.
3. **Download** — the adapter calls Telegram's `getFile` to resolve the
   server-side file path, then streams the file to
   `<download_path>/<uuid><ext>`. The filename is a generated UUID; the
   extension is derived from the MIME type or the original filename, with
   `.bin` as a last-resort fallback.
4. **DB record** — a row is inserted into `attachments`:

   | Column            | Type    | Notes                                  |
   |-------------------|---------|----------------------------------------|
   | id                | TEXT PK | UUID                                   |
   | agent_id          | TEXT    | resolved target recipient id           |
   | local_path        | TEXT    | absolute on-disk path                  |
   | original_filename | TEXT    | nullable; from `document.file_name`    |
   | mime_type         | TEXT    | nullable                               |
   | created_at        | INTEGER | Unix epoch ms                          |
   | expires_at        | INTEGER | Unix epoch ms (`created_at + ttl*1000`) |

5. **Envelope metadata** — the attachment is attached to
   `InboundMessage.attachments` and `processInbound` copies it into
   `envelope.metadata.attachments` so it survives enqueue/dequeue.
6. **Agent delivery** — the CC adapter's channel-notification formatter
   appends one line per attachment after the message body:
   - Images: `[Image: <local_path>]`
   - Files: `[File: <local_path> — <original_filename>]` (filename omitted if unavailable)

Example channel notifications the agent sees:

```
New message from 12345 via telegram at 2026-04-21T14:30 [id:...]:
check this out
[Image: /tmp/agentbus/claude/9a2c-....jpg]
```

```
New message from 12345 via telegram at 2026-04-21T14:30 [id:...]:
here is the document
[File: /tmp/agentbus/claude/3f1a-....pdf — report.pdf]
```

## Email

The email adapter applies the same flow on inbound mail, with two
email-specific behaviors:

- **No download step.** `mailparser` decodes each part into
  `attachment.content` (a `Buffer`), so the adapter writes the bytes directly
  via `persistAttachmentBuffer` — there is no equivalent of Telegram's
  `getFile`/HTTP fetch.
- **Real vs. inline attachments.**
  - **Real attachments** (`Content-Disposition: attachment`) are surfaced to the
    agent exactly like Telegram files/images — `[Image: …]` / `[File: … — name]`
    lines in `metadata.attachments`.
  - **Inline attachments** — HTML-embedded images such as signature logos
    (`mailparser` `related: true`, or `Content-Disposition: inline`) — are
    persisted (so the sweeper reclaims them) but kept **out** of the agent's
    message body to avoid noise. Instead, each is surfaced in
    `metadata.inline_attachments` as `{ id, type, mime_type?,
    original_filename? }`, and the CC adapter renders a single hint line:

    ```
    [Inline image available logo.png — fetch with fetch_attachment(id="<uuid>")]
    ```

| Email part | Attachment type | Surfaced as |
|---|---|---|
| `Content-Disposition: attachment`, `image/*` MIME | `image` | `metadata.attachments` (rendered `[Image: …]`) |
| `Content-Disposition: attachment`, other MIME | `file` | `metadata.attachments` (rendered `[File: …]`) |
| Inline / `related` part (cid-referenced) | `image`/`file` | `metadata.inline_attachments` (hint only) |

### Fetching inline attachments on demand

The `fetch_attachment` MCP tool resolves an attachment `id` (from an inline-image
hint) to its on-disk path so the agent can read it when it decides the image
matters:

- Tool input: `{ id: string }`.
- It calls bus-core `GET /api/v1/attachments/:id`, which returns
  `{ local_path, mime_type, original_filename }` or **404** if the id is unknown
  or the attachment has already expired (TTL swept).

Because inline files are written eagerly at parse time (the bytes only exist
then — IMAP re-fetch is unreliable), unused inline images are reclaimed by the
normal TTL sweep; the agent simply never learns their paths unless it calls the
tool.

## TTL sweep

The `AttachmentSweeper` runs once at bus startup and then every 10 minutes
(hardcoded). Each tick:

- Selects rows from `attachments` where `expires_at <= now`.
- Attempts `unlinkSync(local_path)` for each row. `ENOENT` is tolerated —
  the DB row is deleted regardless so the sweeper never retries the same
  missing file forever.
- Deletes the DB row.
- A single row failure (e.g. permission denied) is logged but does not
  abort the remaining rows.

The 10-minute cadence is not configurable in the current scope.

## Failure modes

| Situation                                    | Behavior                                                   |
|----------------------------------------------|------------------------------------------------------------|
| Attachment-bearing message, no matching route | Warning logged; message still delivered without attachment |
| Matched agent has no `media` block           | Warning logged; message still delivered without attachment |
| Telegram `getFile` or download fails         | Error logged; message still delivered without attachment   |
| `unlink` fails on sweep                      | Error logged; DB row still deleted on non-ENOENT only when the row-delete completes; next sweep will not re-try a missing file because the row is gone |
| Non-file types (video, audio, voice, sticker) | Skipped — no download, no row, no attachment              |

## Related code

- `src/media/attachments.ts` — shared helpers: `extensionFor`,
  `resolveMediaConfig`, `persistAttachmentBuffer`.
- `src/adapters/telegram.ts` — detection, `getFile`, streaming download, DB insert.
- `src/adapters/email.ts` — `persistAttachments`: real vs. inline split.
- `src/http/api.ts` — `InboundMessage.attachments`, envelope metadata
  injection, relaxed guard for empty-body-with-attachments, and
  `GET /api/v1/attachments/:id`.
- `src/pipeline/stages/normalize.ts` — Stage 10 also relaxes its empty-body
  guard when `metadata.attachments` is non-empty; without this an image-only
  message (no caption) is silently dropped before it reaches the queue, even
  though the file itself downloaded successfully.
- `src/mcp/tools/attachments.ts` — the `fetch_attachment` tool.
- `src/adapters/cc.ts` — `formatMessagesForSampling` appends `[Image: …]` /
  `[File: …]` and inline-image hint lines.
- `src/media/attachment-sweeper.ts` — periodic cleanup.
- `src/db/migrations/006_attachments.sql` — table + index.
