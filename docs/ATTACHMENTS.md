# Attachments

AgentBus supports **inbound images only** from Telegram, delivered to the
Claude Code agent as file paths embedded in the channel notification text.
Outbound images and non-image attachments (video, audio, arbitrary documents)
are out of scope.

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

## End-to-end flow

1. **Inbound update** — the Telegram adapter receives a message update
   containing `photo` (compressed) or `document` with an `image/*` MIME.
2. **Target resolution** — the adapter walks `pipeline.routes` to find the
   first rule matching the inbound channel, reads `target.recipientId`,
   and looks up `agents[recipientId].media`. If no `media` is configured,
   a warning is logged and the message is delivered without the image.
3. **Download** — the adapter calls Telegram's `getFile` to resolve the
   server-side file path, then streams the file to
   `<download_path>/<uuid><ext>`. The filename is a generated UUID; the
   extension is derived from the MIME type (`image/jpeg` → `.jpg`,
   `image/png` → `.png`, …) or the original filename, with `.bin` as a
   last-resort fallback.
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
   appends one `[Image: <local_path>]` line per attachment after the
   message body. Empty-caption messages become image-only notifications
   consisting of just the `[Image: …]` line(s).

Example channel notification the agent sees:

```
New message from 12345 via telegram at 2026-04-21T14:30 [id:...]:
check this out
[Image: /tmp/agentbus/claude/9a2c-....jpg]
```

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
| Image-bearing message, no matching route     | Warning logged; message still delivered without attachment |
| Matched agent has no `media` block           | Warning logged; message still delivered without attachment |
| Telegram `getFile` or download fails         | Error logged; message still delivered without attachment   |
| `unlink` fails on sweep                      | Error logged; DB row still deleted on non-ENOENT only when the row-delete completes; next sweep will not re-try a missing file because the row is gone |
| Document with non-image MIME (e.g. `video/*`) | Skipped — no download, no row, no attachment              |

## Related code

- `src/adapters/telegram.ts` — detection, `getFile`, download, DB insert.
- `src/http/api.ts` — `InboundMessage.attachments`, envelope metadata
  injection, relaxed guard for empty-body-with-attachments.
- `src/adapters/cc.ts` — `formatMessagesForSampling` appends `[Image: …]`.
- `src/media/attachment-sweeper.ts` — periodic cleanup.
- `src/db/migrations/006_attachments.sql` — table + index.
