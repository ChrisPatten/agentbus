# Surface API v2 (E96)

The Surface API is the contract between bus-core and the devices that show what agents publish: the iPhone web app today, the Compact (a round 466x466 device) and its phone relay next. It adds per-device credentials, a revisioned resource model with delta push, an action path back into the bus, and a separate TLS listener for the LAN. Protocol v1 ([INTERCOM.md](INTERCOM.md)) keeps working unchanged.

Source: `src/surface/` (types, devices, resources, actions, sessions, conversations, approvals, answer-needed, flags, cert, cert-gen, runtime, inbound-hook), `src/http/surface-routes.ts`, `src/http/surface-listener.ts`, the shared WebSocket handler in `src/http/intercom-routes.ts`, the v2 parts of `src/intercom/service.ts`, migration `046_surface_api.sql`, and the CLIs `scripts/surface-pair.ts`, `scripts/surface-devices.ts`, `scripts/surface-cert.ts`. Epic: `_bmad-output/epics/E96-surface-api-v2.md`.

## Terminology

| Term | Meaning |
|---|---|
| **Surface** | A named content stream agents publish to. Declared under `adapters.intercom.surfaces` and mirrored into the `surfaces` table at startup. A surface follows one conversation (as in v1), owns its resources and their revisions, and lists which agents may publish to it. |
| **Device** | A consumer paired to exactly one surface, with its own credential, name, profile (`round466`, `rectangular`, `phone`, ...) and scope (`interactive` or `read_only`). Rows live in `surface_devices`. Up to `max_devices` (default 10) non-revoked devices per surface. |
| **Legacy device** | The device `<surface>-legacy` created from a surface's pre-E96 shared `token_env` token, so a phone paired before E96 keeps working. |
| **Resource** | A keyed collection of JSON items on a surface (`events`, `slots`, ...), with a monotonic `rev`. |
| **Job** | What sits behind an Event button: a stored inbound payload that fires when a device taps the button. |

Everything in this document is active whenever `adapters.intercom.enabled` is true: bus-core always builds the device store, resource hub and action handler then. With the device store on, **every credential is a device credential**: the shared v1 surface token authenticates only through its legacy device, on both the v1 and v2 paths.

## Configuration

Surfaces stay under `adapters.intercom.surfaces` (see [INTERCOM.md](INTERCOM.md#configure-the-bus) for the other `adapters.intercom` keys). E96 adds two keys and makes `token_env` optional:

| Key | Default | Purpose |
|---|---|---|
| `surfaces[].token_env` | none | Optional. Name of an env var holding a legacy shared token (at least 32 characters). When set and usable, the token becomes the `<surface>-legacy` device credential at startup. Unset or shorter: no legacy device (an existing one is revoked, with a warning). A surface without it is fully usable through paired devices |
| `surfaces[].publishers` | `[]` | Bare agent ids allowed to publish Events, slots and widgets to this surface. `*` allows any agent. Empty: nobody |
| `surfaces[].max_devices` | `10` | Non-revoked devices allowed at once (1-50). The legacy device counts |

The top-level `surface_api` block configures the LAN listener and the v2 runtime:

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `false` | Start the separate TLS listener. The `/api/v1/surface/*` routes are mounted on the main port (`bus.host:bus.http_port`, normally localhost) either way |
| `host` | `0.0.0.0` | Listener bind address |
| `port` | `3443` | Listener port |
| `tls.cert` | none | PEM certificate (chain) file. Required when `enabled`; the config fails validation and the listener refuses to start without it. Also read at startup for the pairing fingerprint, even when `enabled` is false |
| `tls.key` | none | PEM private key file |
| `log_retention_revs` | `500` | Revisions of ops kept per (surface, resource) for resume (10-10,000). Older revs get a `reset` |
| `delta_coalesce_ms` | `250` | At most one delta per (surface, resource) per this window (0-5,000; 0 sends every change at once) |
| `action_key_ttl_hours` | `48` | How long an action's idempotency key and its answer are remembered |
| `action_rate_limit_per_min` | `30` | Actions (HTTP and WS) per device per sliding minute |
| `sessions.activity_timeout_min` | `30` | An `idle` or `finished` session with no activity for this long drops out of the `sessions` resource (unless it needs you) |
| `sessions.include_system` | `false` | Include system sessions (scheduled routines, `system` channels, agent-to-agent conversations) in `sessions` |

```yaml
adapters:
  intercom:
    enabled: true
    surfaces:
      - id: desk
        profile: round466
        follow: { contact: chris, channel: telegram:peggy }
        publishers: [peggy]
        max_devices: 10
      - id: iphone-proto
        token_env: INTERCOM_IPHONE_TOKEN     # legacy token: becomes device iphone-proto-legacy
        follow: { contact: chris, channel: telegram:peggy }

surface_api:
  enabled: true
  host: '0.0.0.0'
  port: 3443
  tls:
    cert: "/Users/chris/.agentbus/surface-tls/server-chain.pem"
    key: "/Users/chris/.agentbus/surface-tls/server.key"
```

Removing a surface from the config deletes its `surfaces` row at the next start; its devices then no longer authenticate.

## TLS setup and certificate pinning

`scripts/surface-cert.ts` creates a private CA and a server certificate with the `openssl` binary (OpenSSL 1.1+/3.x or LibreSSL 3.x):

```sh
npx tsx scripts/surface-cert.ts --host bobafett.local --host 192.168.1.20
```

| Option | Default | Purpose |
|---|---|---|
| `--out <dir>` | `~/.agentbus/surface-tls` | Output directory, created `0700` |
| `--host <name>` | this machine's hostname, `<hostname>.local`, `localhost`, `127.0.0.1` and every non-internal IPv4 | DNS name or IP for the subjectAltName; repeat for more. Names that could inject into the openssl config are rejected |
| `--days <n>` | `825` | Server certificate lifetime, at most 825 (Apple's limit). The CA lasts 10 years |
| `--force` | off | Replace existing files (otherwise any existing output file is an error) |

It writes `ca.key` (0600), `ca.pem`, `server.key` (0600), `server.pem` and `server-chain.pem` (server then CA), prints the names, validity and the server certificate's SHA-256 fingerprint, and prints the `surface_api` YAML to paste (pointing `tls.cert` at `server-chain.pem`). Keys are never printed. Restart bus-core after changing the config.

Devices verify the listener one of two ways:

- **Pin the fingerprint.** The pairing answer carries `cert_fingerprint`, the SHA-256 fingerprint of the leaf certificate in `surface_api.tls.cert` in the form `AA:BB:...` (Node's `fingerprint256`). `surface-pair.ts` prints it too (`TLS SHA-256:`). A microcontroller that cannot hold a CA store pins this value.
- **Trust the CA.** Install `ca.pem` on the device.

Regenerating the server certificate changes the fingerprint; pinned devices must be re-paired.

## Pairing

A one-time code becomes a device with its own credential.

```sh
AGENTBUS_CONFIG=~/workspace/peggy-claude-code/agentbus-config.yaml \
  npx tsx scripts/surface-pair.ts desk --name "Kitchen Compact" --profile round466 --scope interactive --ttl 12h
```

| Option | Default | Purpose |
|---|---|---|
| `--name <text>` | `paired <YYYY-MM-DD>` | Device name (1-64 characters) shown in `surface-devices list` |
| `--profile <p>` | the surface's profile | Display profile hint |
| `--scope <s>` | `interactive` | `interactive` or `read_only` |
| `--ttl <d>` | `adapters.intercom.pair_ttl_hours` (12h) | Code lifetime: `90m`, `12h`, `2d` |
| `--base <url>` | `https://<hostname>:<surface_api.port>` when `surface_api.enabled`, else `$INTERCOM_BASE_URL` or `http://127.0.0.1:<http_port>` | Origin of the printed URL |
| `--config <path>` | `$AGENTBUS_CONFIG` or `./config.yaml` | Config file |
| `--db <path>` | `bus.db_path` | Database file |

It prints the surface, device name, profile and scope, the code, its expiry, the URL `<base>/intercom/#pair=CODE` and, when a certificate is configured, its fingerprint. The code is stored hashed in `surface_pair_codes` (SQLite WAL, so bus-core keeps running); no restart is needed. The CLI syncs surfaces from the config first but leaves legacy devices alone, so the surfaces' `token_env` variables need not be set where it runs.

`scripts/intercom-pair.ts` still works: its v1 codes (in `intercom_pair_codes`) are redeemable on both pair paths and create a device named `paired <date>` with the surface's profile and `interactive` scope.

### `POST /api/v1/surface/pair` (and `POST /api/v1/intercom/pair`)

No auth. Body `{"code":"…"}` (1-64 characters). Both paths use the same handler and share one rate limiter.

`200`:

```json
{"surface_id":"desk","device_id":"desk-3f9a1c07","credential":"sdc_…","token":"sdc_…",
 "scope":"interactive","profile":"round466","cert_fingerprint":"AA:BB:…"}
```

`credential` is shown once; only its sha256 is stored. `token` is the same value, so a v1 client that reads `token` keeps working. `cert_fingerprint` is null when no `surface_api.tls` is configured. Credentials are `sdc_` plus 32 random bytes in base64url; device ids are `<surface>-<8 hex>`.

| Status | `error` | Meaning |
|---|---|---|
| `400` | `invalid_body` | Body is not `{code}` |
| `404` | `unknown` | No such code |
| `409` | `device_limit` | The surface already has `max_devices` non-revoked devices. The code is **not** spent: revoke a device and retry |
| `410` | `expired` / `used` | The code expired, or was already redeemed (a code works once, even under concurrent redeems) |
| `429` | `rate_limited` | More than `adapters.intercom.pair_rate_limit_per_min` (10) attempts per remote address per minute; `Retry-After: 60` |
| `503` | `surface_unavailable` | The code's surface is no longer configured |

Spent and expired v2 codes are deleted a day after they expire or were used, so a retried request still gets `410` rather than `404` for that day.

## Device management

```sh
npx tsx scripts/surface-devices.ts list [surface_id] [--all]
npx tsx scripts/surface-devices.ts revoke <device_id>
```

`list` prints id, surface, name, profile, scope, legacy, created, last seen and revoked; `--all` includes revoked devices. `--config` and `--db` work as for `surface-pair.ts` (with `--db` the config is not loaded). `last_seen_at` is updated at most once a minute per device.

`revoke` sets `revoked_at`. The credential stops authenticating at once (HTTP `401`, WebSocket hello refused with `4401`). The CLI runs in its own process, so bus-core notices on its 5-second surface tick: every open socket of the revoked device is closed with code **4403** `revoked` within one tick. Other devices on the surface are unaffected.

Revoking the legacy device lasts only until the next bus-core start while the surface's `token_env` is still set: startup recreates (un-revokes) it from the token. To keep it out, remove `token_env` or rotate the token. Changing the token value rotates the legacy credential at the next start.

## HTTP endpoints

All paths are under `/api/v1/surface`. They are mounted on the main port and, when enabled, on the TLS listener. They skip the bus `X-Bus-Token` hook and authenticate with `Authorization: Bearer <device credential>`. A missing, unknown or revoked credential answers `401 {"ok":false,"error":"unauthorized"}`.

| Method and path | Auth | Answer |
|---|---|---|
| `GET /health` | Bearer | `{ok, surface_id, follow, version, connected_clients, device_id, scope, protocol: 2}` |
| `GET /state` | Bearer | Snapshot of every resource with its rev (below). `Cache-Control: no-store` |
| `GET /conversations/:id` | Bearer | One page of a conversation transcript (below) |
| `GET /assets/:hash` | Bearer | A content-addressed file (below) |
| `POST /actions` | Bearer | Fire an action (see [Actions and jobs](#actions-and-jobs)) |
| `POST /pair` | none | See [Pairing](#pairing) |
| `GET /ws` | `hello` frame | WebSocket, protocol v2 (see [WebSocket protocol v2](#websocket-protocol-v2)) |

### `GET /state`

Pending coalesced deltas are flushed first, so the snapshot never trails what sockets were sent.

```json
{"surface_id":"desk","device_id":"desk-3f9a1c07","server_time":"2026-11-03T14:00:00.000Z",
 "revs":{"faces":1,"events":4,"slots":0,"widgets":0,"sessions":12,"notices":2,"device":3},
 "resources":{"faces":{"day":{"id":"day","order":0,"enabled":true}, "…":{}},"events":{},"slots":{},"widgets":{},
   "sessions":{},"notices":{},"device":{}}}
```

### `GET /conversations/:id?before=<message_id>&limit=N`

`id` must match `[A-Za-z0-9_:-]{1,128}`; `before` is 1-200 characters; `limit` is 1-100 (default 30). A bad id or query answers `400 invalid_query`.

**Readable conversations.** A device may read the conversation its surface follows, plus any conversation that currently appears (as `conversation_id`) in its surface's `sessions` resource. Anything else, and an unknown conversation, answers `404 not_found`; existence is not revealed.

```json
{"conversation_id":"…","title":"Intercom Build",
 "messages":[{"id":"…","role":"agent","text":"Which train?","created_at":"…",
   "buttons":[{"index":0,"label":"5:37"},{"index":1,"label":"6:10"}],"answer_needed":true}],
 "next_before":"…"}
```

- Source: the `transcripts` table across all sessions of the conversation. Text only: inbound rows are `role: user`, delivered outbound rows `role: agent`. Hidden: `system_only` turns, `context_only` handoffs, bus notices, Intercom echoes, scheduled fires, reaction rows and empty bodies. The transcript holds no tool output.
- Text longer than 2,000 characters is cut and ends with `…`.
- Paging: newest page first, chronological within a page, stable for equal timestamps. `next_before` is the oldest message on the page when older ones exist, else null. An unknown `before` gives an empty page with `next_before: null`.
- `buttons`: open, unexpired choice prompts on that message (callback buttons only; copy and link buttons are left out). `answer_needed: true` marks the message whose question is open (see [Answer needed](#answer-needed)).

### `GET /assets/:hash`

Files are content-addressed in `<directory of bus.db_path>/surface-assets/`, named `<sha256>.<ext>` (or just `<sha256>`). `hash` is 64 hex characters (case-insensitive). The file's sha256 is checked against its name on every request; a missing directory, unknown hash or mismatching content answers `404 not_found`. Content types by extension: png, jpg/jpeg, gif, webp, svg, bmp, json, bin (anything else `application/octet-stream`); `X-Content-Type-Options: nosniff`; `Cache-Control: public, max-age=31536000, immutable` (on the TLS listener too: its `no-store` default applies only to routes that set no `Cache-Control`). There is no upload API yet.

### `POST /actions`

Body: an [action request](#actions-and-jobs). The answer is always an `action_result` object. HTTP status: `400` for `invalid`, `403` for `read_only`, `429` for `rate_limited`, otherwise `200` (including other `failed` results).

## The surface listener

When `surface_api.enabled`, bus-core starts a second Fastify server on `surface_api.host:port` with TLS (minimum TLS 1.2). bus-core's own API and MCP stay on `bus.host:bus.http_port` (default `127.0.0.1:3000`). It serves only:

| Prefix | What |
|---|---|
| `/api/v1/surface`, `/api/v1/surface/*` | Surface API v2 |
| `/api/v1/intercom`, `/api/v1/intercom/*` | The v1 alias (`pair`, `health`, `today`, `desk`, `ws`) |
| `/intercom`, `/intercom/*` | The static web app |

- **Path filter.** An `onRequest` hook runs before routing on the raw request path (before percent-decoding). Anything outside the prefixes answers `404 {"ok":false,"error":"not_found"}`, so bus routes such as `/api/v1/status` or `/mcp` are unreachable even if a module mounted them. It also refuses anything that could be read two ways: `//`, `\`, NUL, `.` and `..` segments, the escapes `%2e`, `%2f`, `%5c`, `%00`, paths over 2,048 characters, and absolute-form request targets. A prefix spelled with escapes (`/api/v1/%73urface/...`) is refused, never decoded into a match. Other escapes are allowed under a prefix. A WebSocket upgrade outside the prefixes is refused the same way.
- **No bus auth.** The `X-Bus-Token` hook is not installed; every route carries its own device auth.
- **Rate limits** (fixed one-minute windows per remote address, not configurable): 600 HTTP requests including upgrades (then `429 rate_limited`, `Retry-After: 60`); 120 new TCP connections (further connections are destroyed).
- **Limits.** Request bodies at most 64 KB (`413`); a 30-second request timeout (not applied to upgraded WebSockets).
- **Headers** on every answer: `X-Content-Type-Options: nosniff`, `Strict-Transport-Security: max-age=86400`, `Referrer-Policy: no-referrer`; `Cache-Control: no-store` on `/api/*` unless the route set its own (assets).
- **Refused.** Plain HTTP on the TLS port gets no HTTP answer. The listener refuses to start without `tls` or with an unreadable file or a file that is not a PEM certificate, naming the path.
- **Logging.** Refusals (`404`, `429`) are logged as `[surface] …`, at most 20 a minute, then a count of the suppressed ones. At start it logs the address and the certificate fingerprint.
- With `surface_api.enabled` but `adapters.intercom` disabled, the listener is not started (a warning is logged).
- **Start failures are not fatal.** An unreadable certificate or a busy port is logged (`[surface] surface listener not started: …`) and bus-core keeps running on its main port.
- **Loopback check.** The listener exists so bus-core's own API and MCP stay on loopback. When `surface_api.enabled` and `bus.host` is not `127.0.0.1`, `localhost` or `::1`, bus-core logs a warning at startup that its own routes are reachable from other hosts.

## Resources

Each surface has seven resources. Every resource is a keyed collection (`id` to JSON object) with its own monotonic `rev` (0 until the first change).

| Resource | Holds | Written by |
|---|---|---|
| `faces` | Which faces the device can show, in order | Default seed at startup (see [Faces](#faces)) |
| `events` | Agent-published Events and bus Approval objects | Agent publishing tools ([S96.5](#agent-publishing-tools-s965)); approval sync |
| `slots` | Temporary overrides of named face slots | Agent publishing tools |
| `widgets` | Data for widgets the client renders | Agent publishing tools |
| `sessions` | Agent sessions with `needs_you` | Computed by the bus every 5 s |
| `notices` | Open E89 notifications for the surface | Mirrored from notifications |
| `device` | Per-device link state | The bus, from sockets and device frames |

Conversations are not a pushed resource: devices fetch them on demand and get live appends while viewing one.

### Ops

A change is a list of ops applied atomically (all or nothing) and producing one new rev:

| Op | Effect |
|---|---|
| `{"op":"set","id","value"}` | Create or replace the item |
| `{"op":"patch","id","value"}` | Shallow-merge `value` into the existing item; a key whose value is `null` is deleted. Patching a missing item is refused (use `set` to create it) |
| `{"op":"remove","id"}` | Delete the item |

Item ids are 1-128 characters at the store level; `value` must be a plain JSON object. Every change bumps the rev, writes the items, logs the ops under the new rev and trims the log to `log_retention_revs` in one transaction.

### Object shapes

These are the item shapes inside resources (`src/surface/types.ts`).

**Event** (`events`):

| Field | Type | Notes |
|---|---|---|
| `id` | string | `[a-z0-9][a-z0-9_-]{0,63}` |
| `kind` | `event` \| `approval` | |
| `title` | string | At most 80 characters |
| `body` | string? | At most 500 |
| `level` | `info` \| `attention` \| `urgent` | |
| `at`, `end` | ISO? | The time the event is about, for placement on the day dial |
| `expires_at` | ISO? | At most 14 days ahead. The bus removes the event after it; its actions answer `expired` |
| `actions` | Action[] | At most 3 |
| `approval` | `{approval_id?, tool?, detail}`? | For `kind: approval`: exactly what is being approved |
| `source` | string | `agent:<id>` or `bus` |
| `created_at`, `updated_at` | ISO | |

**Action** (a button on an Event or Approval): `id` (`[a-z0-9][a-z0-9_-]{0,31}`, unique within the object), `label` (at most 24 characters), `style?` (`default` \| `primary` \| `destructive`), `confirm?` (`{draft, prompt?}`; `draft` at most 2,000 characters, present when tapping sends something on Chris's behalf), `once?` (default true). The job behind a button stays on the bus; the device sees only this.

**Slot** (`slots`, id = slot name): `id`, `text` (at most 60), `icon?`, `color?`, `until` (ISO, at most 24 hours ahead; the bus removes it then), `source`, `updated_at`.

**Widget** (`widgets`): `id`, `type` (`[a-z0-9][a-z0-9_.-]{0,39}`, e.g. `weather`, `countdown`), `data` (object, at most 4,096 bytes as JSON), `source`, `updated_at`.

**Session** (`sessions`): `id`, `title`, `subject` (from `status(subject)`, at most 60, or null), `state` (`stuck` \| `waiting` \| `working` \| `finished` \| `idle`), `channel`, `conversation_id` (or null), `since`, `last_activity_at`, `needs_you`, `needs_you_message_id` (or null), `system`.

**Notice** (`notices`): an E89 notification in its public shape, `{id, key, title, body, level, state, actions, source, created_at, updated_at, expires_at}` (see [NOTIFICATIONS.md](NOTIFICATIONS.md#the-data-model)).

**Face** (`faces`, id = face name): `id`, `order`, `enabled`.

**Device state** (`device`, id = device id): `id`, `name`, `profile`, `scope`, `connected`, `last_seen_at`, `battery` (number or null), `quiet`, `view` (what the device reports showing, e.g. `conversation:<id>`, or null).

### Bounds

From `BOUNDS` in `src/surface/types.ts`. Errors are `BoundsError`s whose message is written for the agent and returned verbatim; nothing is written when one is thrown.

| Bound | Value | Enforced by |
|---|---|---|
| `title` | 80 characters | Publishing tools; approval titles are cut to it |
| `body` | 500 characters | Publishing tools; approval bodies are cut to it |
| `actionLabel` | 24 characters | Publishing tools |
| `actionsPerObject` | 3 | Publishing tools |
| `draft` | 2,000 characters | Job store, action requests; also the transcript text cut and approval `detail` |
| `eventsPerSurface` | 50 live (non-expired) events | Resource store (a change may not raise the count above it) |
| `slotText` | 60 characters | Publishing tools |
| `slotsPerSurface` | 12 | Resource store |
| `slotMaxHours` | 24 | Publishing tools |
| `widgetsPerSurface` | 24 | Resource store |
| `widgetDataBytes` | 4,096 bytes (serialized `data`) | Resource store, including after a patch |
| `subject` | 60 characters | `sessions` cuts it |
| `eventMaxDays` | 14 | Publishing tools |
| `jobPayload` | 4,000 characters | Job store |
| `idemKey` | 100 characters | Action requests |

The per-surface caps refuse only a change that increases the count past the limit, so a surface already over (for example after events stopped expiring) can still remove items.

### Revisions, replay and coalescing

- `rev` per (surface, resource) starts at 0 and goes up by one per applied change. An empty op list is a no-op.
- The last `log_retention_revs` (500) changes are kept for resume.
- **Coalescing.** The first change after a quiet period is sent at once and opens a `delta_coalesce_ms` (250 ms) window. Changes during the window are merged into one trailing frame sent when it ends, which opens a new window. So at most one delta per (surface, resource) per window, and the merged frame's ops reproduce the state. `GET /state`, a v2 resume and shutdown flush pending frames first.
- A socket never receives a frame whose rev it already has (a frame coalesced before its resume is dropped for that socket).

## WebSocket protocol v2

`GET /api/v1/surface/ws`. The same handler serves `/api/v1/intercom/ws`, so the version is chosen by the `hello` frame, not the path. Every v1 frame and rule in [INTERCOM.md](INTERCOM.md#websocket-protocol-v1-apiv1intercomws) still holds; v2 adds frames.

**Hello.**

```json
{"type":"hello","token":"sdc_…","cursor":0,"client":"compact/0.1","protocol":2,
 "revs":{"faces":1,"events":3,"sessions":12}}
```

`protocol` is 1 or 2 (absent means 1: protocol v1 exactly, no v2 frames). `revs` is the device's last-seen rev per resource (non-negative integers; unknown names are ignored). `token` is the device credential. A bad token or invalid hello is answered with `{"type":"error","code":"unauthorized"}` and close **4401**; no valid hello within `hello_timeout_ms` also closes with 4401.

**Welcome** (v2 additions to the v1 frame):

```json
{"type":"welcome","version":2,"surface_id":"desk","follow":{"contact":"chris","channel":"telegram:peggy"},
 "latest_seq":7,"reset":false,"server_time":"…",
 "device_id":"desk-3f9a1c07","scope":"interactive","revs":{"faces":1,"events":4,"slots":0,"widgets":0,"sessions":12,"notices":2,"device":3}}
```

Then, in order: v1 durable replay from `cursor` (unless `reset`), resume frames for every resource, the `activity` snapshot, an `interaction` event if a window is open, the open notifications and `attention` (when notifications are on), `calendar`, and `desk`. The device is marked `connected: true` in the `device` resource.

**Resume rules,** per resource, comparing the hello's rev with the current one:

| Device sent | Server sends |
|---|---|
| The current rev | Nothing |
| An older rev still in the log | One coalesced `delta` from that rev to now (`base_rev` = the device's rev) |
| An older rev no longer in the log, or a rev ahead of the server | A `reset` |
| No rev (or not a valid one) | A `reset` if the resource has any changes (rev > 0), else nothing |

**Delta frame** (server to device), two forms:

```json
{"type":"delta","resource":"events","base_rev":3,"rev":5,"ops":[{"op":"set","id":"arrive","value":{…}},{"op":"remove","id":"old"}]}
{"type":"delta","resource":"events","rev":5,"reset":true,"items":{"arrive":{…}}}
```

Apply ops only when your rev for that resource equals `base_rev`, then take `rev`. Otherwise ignore the frame and re-sync (`GET /state`, or reconnect with your revs). A `reset` replaces the whole collection with `items` at `rev`.

**Device to server** (v2 only; a v1 client sending them gets `invalid_frame`):

| Frame | Answer |
|---|---|
| `{"type":"action","object","action_id","idempotency_key","draft?"}` | `{"type":"action_result","idempotency_key","status","reason?","message_id?"}` (see below) |
| `{"type":"view","view":"conversation:<id>"}` or `{"view":null}` | None. Records what the device shows (a string up to 200 characters, else null) in its `device` item; drives live conversation appends. A conversation the surface may not read (the [readable-conversation rule](#get-conversationsidbeforemessage_idlimitn)) is refused with `{"type":"error","code":"not_found"}` and the view is cleared |

**Live conversation appends.** While a v2 device's `view` is `conversation:<id>` (and the surface may still read it), it receives each new message in that conversation as an ephemeral event frame:

```json
{"type":"event","event":"conversation_append","data":{"conversation_id":"…","message":{"id":"…","role":"agent","text":"…","created_at":"…","buttons":[…],"answer_needed":true}}}
```

Inbound messages are appended after the pipeline accepts them (including surface sends), agent messages after delivery. The same hiding rules as the page apply; only `contact:` and `agent:` senders appear.

**Other v2 behaviour.**

- `state` frames (`quiet`, `battery`) also update the device's `device` item.
- A `read_only` device may connect, receive everything and send `ping`, `state`, `view` and `notification_ack`. `send` and `notification_action` answer `{"type":"error","code":"read_only"}`; an `action` answers `action_result` `failed` / `read_only`.
- Close codes: **4401** unauthorized or hello timeout, **4403** `revoked` (the device was revoked), 1001 ping timeout.
- Voice frames are reserved for a later epic and not implemented.

## Actions and jobs

One handler serves `POST /api/v1/surface/actions` and the WS `action` frame.

**Request.**

| Field | Rule |
|---|---|
| `object` | `events:<id>` or `notices:<id>` (id 1-128 characters, no `:` or whitespace) |
| `action_id` | `[a-z0-9][a-z0-9_-]{0,31}`; for a notice, the action's index (`"0"`, `"1"`, ...) |
| `idempotency_key` | 1-100 characters, generated by the device, unique per tap. A retry of the same tap reuses it |
| `draft` | Required, and must match exactly, when the action has `confirm.draft` (at most 2,000) |

**Order of checks.** Malformed request: `failed` / `invalid` (not remembered). Read-only device: `read_only`. More than `action_rate_limit_per_min` actions from this device in the last 60 s: `rate_limited`. Then requests are serialised per (surface, key), and a remembered key answers from memory.

**Idempotency.** Keys are scoped to the surface (not the device) and remembered for `action_key_ttl_hours`. A repeat of a key whose first answer was `done` (or `already_done`) answers `already_done` with the first `message_id`; a repeat of any other remembered outcome replays it. Concurrent duplicates fire once. `internal_error` is never remembered, so the same key may retry.

**Event actions** (`events:<id>`). A job is the scheduler's item shape with `trigger: action`, stored in `surface_jobs` under `events:<event id>:<action id>`, with `channel`, `sender`, `topic` (default `general`), `payload_body`, `sends_on_behalf`, `confirm_draft`, `once`, `expires_at`. When it fires, the payload is injected into the inbound pipeline as the scheduler injects a fire: a text message from `sender` on `channel`/`topic`, with metadata `origin: surface_action`, `surface_id`, `device_id`, `object`, `action_id`, `job_id` and `idempotency_key`.

- **One-shot.** `once` jobs (the default) fire at most once across all keys; later taps answer `already_done`. Replacing an Event's jobs keeps the fire count of an action id that survives, so editing an Event cannot re-arm a button that already fired.
- **Expiry.** A tap after the job's or the Event's `expires_at` answers `expired`.
- **`confirm.draft`.** A job that sends on Chris's behalf must store a draft (the job store refuses one without). It fires only when the Event's button shows the same `confirm.draft` and the device echoes it in `draft`. A sends-on-behalf job whose button has no draft, or whose stored and shown drafts differ, never fires (`confirm_required`). For any action with a draft: no `draft` in the request answers `confirm_required`, a different one `draft_mismatch`.
- **Result.** Queued for an agent: `done` with `message_id`. Accepted but routed nowhere: `failed` / `no_route`. A slash command the bus handled: `done`. A pipeline abort: `failed` with its reason. A thrown pipeline error: `internal_error`, and the job is un-claimed so the same key can retry.

**Notice actions** (`notices:<id>`, action id = index) go through the E89 `notification_action` path: the notification is acknowledged and `[tapped] <label>` is sent into the followed conversation like a surface send, with the idempotency key as `client_msg_id`. `queued` or `command` answers `done`; an unknown, terminal or untargeted notice `not_found`; a bad index `invalid`. See [NOTIFICATIONS.md](NOTIFICATIONS.md#surface-api-v2-e96).

**Approval actions** (`events:approval-<id>`, action `approve` or `deny`) resolve the bus approval (see [Approvals](#approvals)).

**Results.**

| `status` | `reason` | When |
|---|---|---|
| `done` | | Fired (or approval answered by this tap); `message_id` when a message was injected |
| `already_done` | | A `once` action already fired, the key was already answered `done`, or the approval was answered elsewhere |
| `expired` | | The job, Event or approval expired |
| `failed` | `invalid` | Malformed request (HTTP 400) |
| `failed` | `read_only` | Read-only device (HTTP 403) |
| `failed` | `rate_limited` | Over `action_rate_limit_per_min` (HTTP 429) |
| `failed` | `not_found` | No such Event, action, job, notice or (addressed) approval |
| `failed` | `confirm_required` | Draft rule not met, or the request lacks the draft |
| `failed` | `draft_mismatch` | The echoed draft differs |
| `failed` | `no_route` | The injected message reached no agent |
| `failed` | `stale: <reason>` | The approval can no longer be answered (pane moved on, no backend) |
| `failed` | `internal_error` | Unexpected error; retry with the same key |
| `failed` | other | The pipeline's abort reason |

## Sessions resource

Computed every 5 s (and at once when an answer-needed flag is set or cleared, or a subject changes) from E94's desk classification of the cc-pool panes. A surface lists only sessions whose conversation belongs to its followed contact (per the conversation registry) plus panes with no known conversation, because the list also decides which transcripts a device may read.

- **Ids.** The conversation id when the pane has one, else the pane's bare agent id made id-safe.
- **`needs_you`** is true only while an [answer-needed](#answer-needed) flag is open for the session's conversation. A desk state of `waiting` or `stuck` (pending approval, open choice prompt, watchdog incident) stays in `state` and never sets `needs_you`.
- **Open questions without a pane.** A flagged conversation whose pane was released still appears, with `state: idle`, so an open question never disappears.
- **Timeout.** `idle` and `finished` sessions with no activity for `sessions.activity_timeout_min` (30) drop out; `working`, `waiting`, `stuck` and every `needs_you` session stay.
- **System sessions** are excluded unless `sessions.include_system`: channel `system` or `system:*`, a conversation whose contact is `system:*` or `agent:*`, a scheduled routine's conversation (topic `sched:*`, or the channel and topic of an active cron schedule). A `needs_you` session is never hidden. cc-headless instances are not in the desk input at all.
- **`subject`** comes from `status(subject)` per conversation (S96.5), cut to 60 characters.
- **Order and size.** `needs_you` first, then stuck, waiting, working, finished, idle; newest `since` first; then id. At most 24 items.

## Approvals

Every `pending`, unexpired bus approval (E51 `approval_requests`, including E68 self-edit proposals) addressed to a surface's followed contact appears in that surface's `events` resource as a `kind: approval` Event:

- id `approval-<approval id>`, `level: attention`, `expires_at` = the approval's expiry, `source: bus`;
- title `<tool>: <summary>` (self-edit: `Proposed change`), body `Agent <id> · <conversation title> asks to use <tool>.`;
- actions `approve` (primary) and `deny` (destructive), both one-shot;
- `approval.detail` = exactly what is being approved: `raw_context.details` when a backend supplied one, else the full shell command (`tool_input.command`), else the summary. Cut to 2,000 characters with `… [N more characters]`.

The set is synced on the 5-second tick and right after a device answers; agent-published Events are never touched. Approve or Deny resolves through `resolveApproval()`, the same path the Telegram buttons and `POST /api/v1/approvals/:id/resolve` use, so staleness, expiry, the in-flight guard, the pane keystroke and the `onResolved` hooks are identical. `resolved_by` is `device:<device id>`. Another contact's approval answers `not_found`. The Telegram message's buttons are removed by the approvals sweep. See [APPROVALS.md](APPROVALS.md#approving-from-a-surface-e96).

## Answer needed

A per-conversation flag (`surface_answer_needed`, one per conversation: a newer question replaces the older one) that marks a question the agent is waiting on.

- **Set** by `reply` / `send_message` with `answer_needed` (S96.5, see [below](#agent-publishing-tools-s965)).
- **Cleared** by a choice-button tap on that conversation's prompt (when the tap is answered), by a message from the contact in that conversation (scheduled fires, `system_only` turns and `agent:` or `system:` senders do not clear it), or by the explicit clear tool. A clear pushes a `sessions` update at once.
- **Shown** as `needs_you` / `needs_you_message_id` in `sessions`, and as `answer_needed: true` on the question message in the conversation page and live appends.

## Faces

At startup each surface with an empty `faces` resource is seeded with `day` (order 0), `status` (1) and `desk` (2), all enabled. Nothing else writes `faces` yet.

## Notices

The `notices` resource mirrors the surface's open E89 notifications (`active` and `acknowledged`, targeted at the surface or `*`), keyed by notification id, in the public notification shape. It is synced at startup and on every notification create, update, state change and expiry. With `notifications.enabled: false` it is empty. The v1 `notification` and `attention` events continue alongside it.

## Device resource

Each device that has connected has an item in its surface's `device` resource. It is patched on connect (`connected: true`), when the device's last socket closes (`connected: false`), on `state` frames (`quiet`, `battery`) and on `view` frames. Every device on the surface sees every other device's item. Items are not removed when a device is revoked.

## Sweeps and ticks

| Cadence | Work |
|---|---|
| Every 5 s (the service's desk tick) | Close sockets of revoked devices (4403); recompute `sessions`; sync approval Events |
| Every 60 s (surface runtime) | Remove Events past `expires_at` and slots past `until` (through the store, so devices get deltas); delete jobs expired more than a day ago (they are kept until then so a late tap answers `expired`, not `not_found`); delete idempotency keys older than `action_key_ttl_hours`; delete v2 pairing codes spent or expired more than a day ago |
| Every 60 s (notifications) | Expire due notifications, which updates `notices` |
| Hourly (service) | v1 durable-event retention and v1 pairing codes, as before |

## Deviations and not yet reconciled

- **Object shapes were defined here.** The epic names `peggy-claude-code/data/intercom/architecture.md` section 3 as the contract for Event, slot, session and conversation shapes and bounds. That document was not available on the machine where E96 was built, so the shapes and bounds in `src/surface/types.ts` (and this document) were written without it. Reconcile any difference in architecture.md first, then here.
- **Voice frames** are reserved in protocol v2 and not implemented.
- **Assets have no upload API.** Files are placed in `<db dir>/surface-assets/` by hand, named by their sha256.
- **Conversation buttons are display-only.** The page and live appends carry choice `buttons`, but there is no action object for choice prompts yet; a device cannot tap them through `POST /actions`.
- **`faces` has no writer** beyond the startup seed; an agent cannot reorder faces yet.
- **v1 re-pairing creates a device each time.** A phone that loses its stored token and pairs again with a v1 code gets a new device; after `max_devices` of them the code answers `409 device_limit` (which the v1 web app does not explain). Revoke stale devices with `scripts/surface-devices.ts`.

## Agent publishing tools (S96.5)

Agents publish through MCP tools, registered for cc-pool panes, Claude Code and cc-headless instances. Each tool calls a bus route under `/api/v1/surface-publish/` on the main port, behind the usual `X-Bus-Token`; the agent names itself with `agent_id` (body for `PUT`/`POST`, query for `GET`/`DELETE`). The bus's error message is returned to the agent verbatim.

**Authorisation.** The agent must be listed in the surface's `publishers` (`adapters.intercom.surfaces[].publishers`; `*` allows any agent; empty means nobody). A pool pane such as `peggy-pool-3` counts as `peggy`. Otherwise `403` names the config key; an unknown surface `404` lists the surfaces the agent may publish to.

| Tool | Route | What |
|---|---|---|
| `list_surfaces` | `GET surfaces?agent_id=` | Surfaces this agent may publish to, with their follow target |
| `surface_publish_event` | `PUT :surface/events/:id` | Create or replace an Event (`201` new, `200` replaced; `created_at` kept) |
| `surface_remove_event` | `DELETE :surface/events/:id` | Remove an Event and its jobs |
| `surface_set_slot` | `PUT :surface/slots/:slot` | Override a face slot until `until` |
| `surface_clear_slot` | `DELETE :surface/slots/:slot` | End the override |
| `surface_write_widget` | `PUT :surface/widgets/:id` | Write a widget's `type` and `data` |
| `surface_remove_widget` | `DELETE :surface/widgets/:id` | Remove a widget |
| `clear_answer_needed` | `POST answer-needed/clear` | Clear a conversation's flag (`conversation_id`, or `channel` + `contact` + `topic`; with no arguments cc-headless uses its turn's conversation) |

**Event input.** `{id, title, body?, level?, at?, end?, expires_at?, actions?}`. `expires_at` defaults to 24 hours ahead and must be in the future and at most 14 days ahead. Each action is `{id, label, style?, confirm?: {draft, prompt?}, once? (default true), run: {body, sends_on_behalf?}}`: `run.body` is the message injected into the surface's followed conversation (as the followed contact, like a scheduled fire) when the button is tapped. `sends_on_behalf: true` requires `confirm.draft`. Jobs always target the follow conversation. Editing an Event keeps the fire count of actions whose id survives, so a fired one-shot button is not re-armed. Agents cannot write `kind: approval` or change bus-owned Events. Every bound in [Bounds](#bounds) is checked and an over-limit call answers `400` with a message naming the field and the limit, and nothing is written (the jobs and the Event are written in one transaction).

**`answer_needed`** on `reply` and `send_message` (next to `choices`): stored as `metadata.answer_needed`; when true on agent-sent text, `POST /api/v1/messages` sets the conversation's flag (the reply's conversation, else the bound `metadata.conversation_id`, else the hash of recipient, channel and topic). A message without it never sets the flag. See [Answer needed](#answer-needed).

**`status(subject)`**: an optional line (at most 60 characters, sanitised like the status text) saying what the whole session is about. cc-headless's stream parser and the pool's tool-status hook post it with the status line to `POST /api/v1/adapters/:id/tool-status`, which stores it for the conversation (`conversation_id` when given, else the pool lease with that Claude `session_id`, else the hash of contact, channel and topic). Limitation: cc-headless ignores tool calls after the reply is delivered, so a `subject` set after the reply is lost there; the pool hook still posts it.

## Migration note: AgentBus to Intercom rename

The v2 paths live under `/api/v1/surface` deliberately: the name is product-neutral, so the planned rename of AgentBus to Intercom does not move them again. `/api/v1/intercom/*` stays as an alias (same handlers, same credentials, same WebSocket handler with protocol v2 available) until the web prototype migrates to `/api/v1/surface` in E97. Clients written now should use `/api/v1/surface`.
