# E17 — Inbound Image Handling

| Field | Value |
|---|---|
| Epic ID | E17 |
| Dependencies | E1 (DB/migrations), E3 (Telegram adapter), E13 (CC adapter sampling) |
| Story Count | 6 |
| Estimated Complexity | M |

---

## Epic Summary

When a user sends an image via Telegram, the bus currently drops it silently. E17 adds end-to-end inbound image handling: the Telegram adapter detects photo/document (image MIME) messages, downloads the file via the Bot API, saves it to a per-agent local directory, records it in a new DB `attachments` table with an expiration timestamp, and delivers the local file path to the agent via the CC adapter's message text. A background sweep periodically deletes expired files and their DB rows.

Scope is intentionally narrow: inbound images only, Telegram source, CC adapter delivery. Outbound image sending, non-image attachments (video/audio/document), and BlueBubbles are out of scope.

---

## Entry Criteria

- E1 complete: DB client and migration system operational
- E3 complete: Telegram adapter receiving messages
- E13 complete: CC adapter delivering inbound messages via `sampling/createMessage`

---

## Exit Criteria

- Sending a photo in Telegram results in the agent receiving a message containing `[Image: <local_path>]`
- The image file exists at that path and is readable
- The `attachments` DB table records the file with correct `agent_id`, `expires_at`, and metadata
- On startup and periodically, files past their `expires_at` are deleted from disk and removed from the DB
- A Telegram text message (no photo) is unaffected — no regressions
- Per-agent config controls where images land and how long they live

---

## Config Shape

New top-level `agents:` section in `config.yaml`, keyed by recipient ID:

```yaml
agents:
  agent:claude:
    media:
      download_path: /tmp/agentbus/claude
      ttl_seconds: 3600
```

`download_path` is created at startup if it does not exist. `ttl_seconds` defaults to `3600`. Agents without a `media` block receive no image delivery (images are dropped with a warning).

---

## Stories

### S17.1 — Config Schema: Per-Agent Media Settings

**User story:** As an operator, I want to configure per-agent image download settings so that different agents can store images in different locations with different retention periods.

**Acceptance criteria:**
- New top-level `agents:` key in `AppConfigSchema`: `z.record(z.string(), AgentConfigSchema).default({})`
- `AgentConfigSchema` has a `media` field: `{ download_path: z.string(), ttl_seconds: z.number().int().positive().default(3600) }`
- On startup, bus creates `download_path` directory for each configured agent if it does not exist
- Invalid config (e.g. negative TTL) fails validation with a clear error at startup
- Unit tests: valid config parses correctly; missing `media` block defaults correctly; invalid TTL is rejected

**Complexity:** S

---

### S17.2 — DB Migration: `attachments` Table

**User story:** As the bus, I want a DB table to track downloaded image files so that the TTL sweep knows which files to delete and when.

**Acceptance criteria:**
- New migration adds `attachments` table with columns:
  - `id` TEXT PRIMARY KEY (UUID)
  - `agent_id` TEXT NOT NULL
  - `local_path` TEXT NOT NULL
  - `original_filename` TEXT
  - `mime_type` TEXT
  - `created_at` INTEGER NOT NULL (Unix ms)
  - `expires_at` INTEGER NOT NULL (Unix ms)
- Migration runs automatically on startup via existing migration system
- No changes to existing tables
- Unit test: migration applies cleanly on a fresh DB; idempotent on re-run

**Complexity:** S

---

### S17.3 — Telegram Adapter: Detect and Download Images

**User story:** As the Telegram adapter, I want to detect incoming photo and image document messages, download the file, and attach it to the inbound message envelope so that downstream stages can deliver it to the agent.

**Acceptance criteria:**
- Adapter detects `message.photo` (array — use largest size) and `message.document` where `mime_type` starts with `image/`
- Calls Telegram `getFile` API to resolve the file path, then downloads via `https://api.telegram.org/file/bot<token>/<file_path>`
- Saves file to the target agent's `download_path` as `<uuid>.<ext>` (extension derived from mime type or original filename)
- Target agent is resolved from the pipeline route for the incoming channel — if no agent config has `media` set, logs a warning and skips download
- Inserts a row into `attachments` with `expires_at = now + ttl_seconds * 1000`
- Populates `InboundMessage.attachments` with `[{ type: 'image', local_path, mime_type }]`
- Download errors are caught and logged; message is still delivered (without attachment) rather than dropped
- Unit tests: photo message → file downloaded + DB row inserted; document with non-image MIME → skipped; download failure → message delivered without attachment

**Complexity:** M

---

### S17.4 — CC Adapter: Deliver Image Path in Message Text

**User story:** As the agent, I want to see the local file path of any attached image in my message text so that I can read or describe the image.

**Acceptance criteria:**
- When formatting a message for `sampling/createMessage`, if `envelope.attachments` is non-empty, append one `[Image: <local_path>]` line per attachment after the message body
- Multiple attachments produce multiple lines
- Messages with no attachments are unchanged
- Unit test: message with one attachment → path appended; two attachments → two lines; no attachment → unchanged

**Complexity:** S

---

### S17.5 — TTL Cleanup Sweep

**User story:** As the bus, I want to periodically delete expired image files and their DB records so that disk space is not consumed indefinitely.

**Acceptance criteria:**
- Sweep runs once at bus startup and then on a fixed interval (default: every 10 minutes; not configurable in this epic)
- Sweep queries `attachments` where `expires_at <= now`
- For each row: attempts `fs.unlink` on `local_path` (ignores ENOENT), then deletes the DB row
- Sweep errors are caught per-row and logged; a single failure does not abort the sweep
- Unit test: expired row → file deleted and row removed; non-expired row → untouched; missing file → row still deleted

**Complexity:** S

---

### S17.6 — Docs

**User story:** As a developer setting up image handling, I want documentation covering config, the DB table, and the end-to-end flow.

**Acceptance criteria:**
- New or updated doc in `docs/` covering:
  - `agents:` config section with `media.download_path` and `media.ttl_seconds`
  - End-to-end flow: Telegram photo → download → DB row → CC adapter text → agent
  - TTL sweep behavior
  - What happens when no `media` config is present for an agent
- `config.yaml.example` updated with a commented `agents:` block

**Complexity:** S
