# Surface API v2 (E96)

The Surface API is the contract between bus-core and the devices that show what agents publish: the iPhone web app today, the Compact (a round 466x466 device) and its phone relay next. It adds per-device credentials, a revisioned resource model with delta push, an action path back into the bus, and a separate TLS listener for the LAN. Protocol v1 ([INTERCOM.md](INTERCOM.md)) keeps working unchanged.

Source: `src/surface/` (types, devices, resources, actions, lifecycle, sessions, conversations, approvals, answer-needed, flags, cert, cert-gen, runtime, inbound-hook), `src/http/surface-routes.ts`, `src/http/surface-listener.ts`, the shared WebSocket handler in `src/http/intercom-routes.ts`, the v2 parts of `src/intercom/service.ts`, migration `046_surface_api.sql`, and the CLIs `scripts/surface-pair.ts`, `scripts/surface-devices.ts`, `scripts/surface-cert.ts`. Epic: `_bmad-output/epics/E96-surface-api-v2.md`.

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
| `event_tombstone_hours` | `24` | How long an ended Event (answered, expired, withdrawn, cleared) stays in `events` as a tombstone after its `ended_at` (0-168 hours, more than 0). See [Moment lifecycle](#moment-lifecycle-e100) |
| `action_rate_limit_per_min` | `30` | Actions (HTTP and WS) per device per sliding minute |
| `asset_max_bytes` | `1048576` | Largest file the asset upload route accepts (1 KiB to 16 MiB) |
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

Files are content-addressed in `<directory of bus.db_path>/surface-assets/`, named `<sha256>.<ext>` (or just `<sha256>`). Agents put files there with [`POST /api/v1/surface-publish/assets`](#assets-upload) (`surface_upload_asset`); devices only read. `hash` is 64 hex characters (case-insensitive). The file's sha256 is checked against its name on every request; a missing directory, unknown hash or mismatching content answers `404 not_found`. Content types by extension: png, jpg/jpeg, gif, webp, svg, bmp, json, bin (anything else `application/octet-stream`); `X-Content-Type-Options: nosniff`; `Cache-Control: public, max-age=31536000, immutable` (on the TLS listener too: its `no-store` default applies only to routes that set no `Cache-Control`).

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
| `events` | Agent-published Events and bus Approval objects, open and (for a while) ended ones ([Moment lifecycle](#moment-lifecycle-e100)) | Agent publishing tools ([S96.5](#agent-publishing-tools-s965)); approval sync |
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
| `level` | `info` \| `attention` \| `urgent` | Always present. Derived from `weight` when the agent gave only a weight |
| `weight` | `ambient` \| `notice` \| `decision` \| `urgent`? | E100 Moment weight. Stored only when the agent gave one; clients map `level` otherwise (info → ambient, attention → decision, urgent → urgent). Approvals carry `decision` |
| `consequence` | string? | E100, urgent only (weight or level `urgent`): what happens if nothing is done, e.g. `Misses your 7:15 transfer`. At most 60 characters, one line |
| `changed` | `{field, old, new}`? | E100, urgent only: what changed. `field` is `start`, `end`, `place`, `title` or `other`; `old` and `new` at most 24 characters each (`6:42` → `6:58`) |
| `state` | `open` \| `answered` \| `expired` \| `withdrawn` \| `cleared` | E100, bus-owned. `open` on every publish; the others are terminal (a tombstone, see [Moment lifecycle](#moment-lifecycle-e100)). Absent on items stored before E100: read it as `open` |
| `ended_at` | ISO? | E100: when a terminal Event ended (the expiry time for `expired`, the resolution time for an approval, else the moment it ended). Absent while open |
| `at`, `end` | ISO? | The time the event is about. **Ring placement:** only a `kind: event` with both `at` and `end` draws a segment on the Day Dial ring; with only `at` it is a card. Approvals never draw (the bus does not give them `at`/`end`) |
| `layer` | `primary` \| `overlap`? | Ring layer (needs `at` and `end`); absent means `primary`. At any moment at most 1 `primary` and 2 `overlap` ring events may overlap in time; a publish that would break that is refused naming the clash |
| `color` | string? | Ring segment colour (needs `at` and `end`): `#rgb`, `#rrggbb` or `orange`, `red`, `green`, `blue`, `purple`, `yellow`, `teal`, `pink`, `gray`, `white`. Stored lowercase |
| `travel` | `{minutes, mode?}`? | Travel time before the event (needs `at` and `end`); drives the travel wedge and leave-by. `minutes` is a whole number 1-720, `mode` is `walk`, `drive`, `transit`, `bike` or `train` |
| `detail` | `{description?, location?, image?}`? | The focus view's content. `description` at most 600 characters, `location` at most 120, `image` an asset hash (64 hex; `asset:<hash>` is accepted and stored as the bare hash). On publish the image must already be in the asset store |
| `opens` | `focus` \| `conversation`? | What a tap opens; absent means `focus` |
| `conversation_id` | string? | Required when `opens` is `conversation`, and only allowed then |
| `expires_at` | ISO? | At most 14 days ahead. After it the event becomes an `expired` tombstone; its actions answer `expired` |
| `actions` | Action[] | At most 3 |
| `approval` | `{approval_id?, tool?, detail}`? | For `kind: approval`: exactly what is being approved |
| `source` | string | `agent:<id>` or `bus` |
| `created_at`, `updated_at` | ISO | |

**Action** (a button on an Event or Approval): `id` (`[a-z0-9][a-z0-9_-]{0,31}`, unique within the object), `label` (at most 24 characters), `style?` (`default` \| `primary` \| `destructive`), `confirm?` (`{draft, prompt?}`; `draft` at most 2,000 characters, present when tapping sends something on Chris's behalf), `once?` (default true), `kind` (E100: `tap` or `hold`). The job behind a button stays on the bus; the device sees only this.

`kind` is resolved by the bus and always stored on buttons published after E100 (Event buttons, the primary slot's button, approvals): the default is `hold` when the button has `confirm` or `run.sends_on_behalf`, else `tap`. An explicit `tap` on a button that sends is refused (anything that sends must be held to confirm); an explicit `hold` on a plain button is allowed, for irreversible things. Approve and Deny are `hold`. Items stored before E100 have no `kind`; clients treat a `confirm.draft` as `hold`.

**Slot** (`slots`, id = slot name): `id`, `text?` (at most 60), `icon?`, `color?`, `until` (ISO, at most 24 hours ahead; the bus removes it then), `source`, `updated_at`. Two slot names have a meaning:

- `primary`: `text` plus an optional `action` (one button, the [Action](#object-shapes) shape; its job is created with the slot and removed with it, see [slot actions](#actions-and-jobs)).
- `context`: either `lines` (1-2 strings, each at most 40 characters) or `widgets` (1-3 ids of widgets that exist on the surface when the slot is set; a dangling id is refused, and a bound widget cannot be removed until the slot is updated or cleared). The legacy `text` form still validates.

Any other slot name takes `text` (and `icon`, `color`) only. `lines`, `widgets` and `action` on the wrong slot are refused.

**Widget** (`widgets`): `id`, `type` (`[a-z0-9][a-z0-9_.-]{0,39}`, e.g. `weather`, `countdown`), `data` (object, at most 4,096 bytes as JSON), `source`, `updated_at`.

**Session** (`sessions`): `id`, `title`, `subject` (from `status(subject)`, at most 60, or null), `state` (`stuck` \| `waiting` \| `working` \| `finished` \| `idle`), `channel`, `conversation_id` (or null), `since`, `last_activity_at`, `needs_you`, `needs_you_message_id` (or null), `system`.

**Notice** (`notices`): an E89 notification in its public shape, `{id, key, title, body, level, state, actions, source, created_at, updated_at, expires_at}` (see [NOTIFICATIONS.md](NOTIFICATIONS.md#the-data-model)).

**Face** (`faces`, id = face name): `id`, `order`, `enabled`, `layout?` (see [Faces](#faces)).

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
| `eventsPerSurface` | 50 live events (open and not past `expires_at`; tombstones do not count) | Resource store (a change may not raise the count above it); the publish route also counts reviving a tombstone as a new event |
| `consequence` | 60 characters | Publishing tools (urgent events only) |
| `changedValue` | 24 characters each for `changed.old` and `changed.new` | Publishing tools (urgent events only) |
| `slotText` | 60 characters | Publishing tools |
| `contextLines` / `contextLineText` | 2 lines / 40 characters each | Publishing tools |
| `contextWidgets` | 3 widget ids | Publishing tools |
| `description` / `location` | 600 / 120 characters (`detail`) | Publishing tools |
| `travelMinutes` | 720 | Publishing tools |
| `ringPrimary` / `ringOverlap` | 1 / 2 overlapping ring events per layer | Publishing tools (checked against live events: tombstones and expired events never block) |
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
- Push-to-talk audio frames: see [Push-to-talk audio](#push-to-talk-audio-e92).
- The `welcome` (and `GET /health`) `follow` object carries `conversation_id`, the followed conversation's id, so a device can open its thread (`GET /conversations/:id`, `view`) without computing the hash itself.

### Spoken replies

When an interaction's latest surface message came from push-to-talk, the agent's replies in that interaction are spoken on the socket that sent it. Source: `src/intercom/speech.ts`.

| Frame | Direction | Meaning |
|---|---|---|
| `{"type":"speech_start","id","rate","format":"pcm_s16le","chars"}` | bus → device | An utterance begins. `rate` is the PCM sample rate (16000 by default), `chars` the length of the spoken text. A new `speech_start` replaces whatever was playing |
| binary frames | bus → device | 16-bit little-endian mono PCM, 3,200 bytes each (the last may be shorter, always whole samples) |
| `{"type":"speech_end","id","ms","truncated?"}` | bus → device | All audio sent; `ms` of it. `truncated: true` when `voice.speech.max_seconds` cut it |
| `{"type":"speech_cancel","id","reason"}` | bus → device | Stopped early: `tts_error`, `timeout`, `replaced`, `listening` (an `audio_start` from this socket), `stopped`, `muted` or `asleep`. A cancel for an id that is no longer playing is to be ignored |
| `{"type":"speech_stop"}` | device → bus | The device stopped playing (PWR, a new press): the bus stops sending |
| `state` frame `volume` (0-100) or `speech` (bool) | device → bus | `volume: 0` or `speech: false` mutes the device: nothing is synthesised or sent. `quiet: true` (the Compact sends it while asleep) holds speech too |

- **What is spoken (fallback):** since E102 the agent normally calls [`speak`](#the-speak-tool-e102) itself and this automatic rule is only the fallback. The reply body when, as plain text (Markdown, links, emoji and list markers removed), it is at most `voice.speech.max_chars` (160); otherwise its glance line. Never a long body.
- **When:** only replies delivered in the interaction window to the socket whose push-to-talk message started or last refreshed it, at most `voice.speech.max_replies` (2) per message and within `voice.speech.reply_window_s` (300). A typed `send` in the same window turns it off; notifications, Events and typed messages are never spoken. Never in `voice.speech.quiet_hours` (default 22:00-07:00 in `voice.speech.timezone`), never on a surface with `speech: false`, never to a muted or sleeping device.
- **Bounds:** at most `voice.speech.max_seconds` (20) of audio and `voice.speech.timeout_ms` (15 s) per utterance; one at a time per socket.
- **Engine:** ElevenLabs streaming text-to-speech, `POST <base_url>/v1/text-to-speech/<voice_id>/stream?output_format=pcm_16000`, model `voice.elevenlabs.tts_model` (`eleven_flash_v2_5`). Without `ELEVENLABS_API_KEY` nothing is spoken. 16 kHz is the default because the Compact's speaker shares its I2S clock with the microphones.
- **Log:** `[intercom] {"evt":"speech","id","chars","audio_ms","ms","end"}` per utterance and `{"evt":"speech_skipped",...,"why"}` when a voice interaction's reply is not spoken (`off`, `surface_off`, `enough`, `late`, `gone`, `muted`, `asleep`, `quiet_hours`).

### The `speak` tool (E102)

The agent chooses what is said. `speak(message_id, text)` (MCP, both cc-pool and cc-headless tool sets) says `text` on the device that sent that push-to-talk message; the tool takes no device id, the bus resolves it from the message's interaction exactly as automatic speech does. Source: `src/mcp/tools/speak.ts`, `IntercomService.speakFor`, route `POST /api/v1/speak` (shared bus token).

- **Allowed** only for an inbound message with `input: "voice"` while its interaction is open, within `voice.speech.reply_window_s`, and until a typed `send` follows it. Anything else is an error (`ok: false`) and nothing is spoken: the agent should `reply()`.
- **Guards:** the same as automatic speech (quiet hours, muted, asleep, surface `speech: false`, `max_replies` per voice message, `max_seconds`, `timeout_ms`, one utterance at a time per socket). A blocked call returns `{status: "skipped", reason}` (`quiet_hours`, `muted`, `asleep`, `off`, `surface_off`, `enough`, `gone`): nothing is spoken, shown or recorded. Text over `voice.speech.speak_max_chars` (400), or empty after cleaning, is an error.
- **Audio tags** (`[warmly]`, `[quickly]`, `[short pause]`) are sent to ElevenLabs untouched and are not counted or shown. Markdown, links and emoji are stripped as for replies. Note: tags are read aloud by models that do not support them (`eleven_flash_v2_5`); use `eleven_v4_turbo` (or another tag-aware model) in `voice.elevenlabs.tts_model`.
- **Returns at once:** `spoken` (audio is streaming now), `queued` (it follows an utterance still playing on that device; utterances never cut each other off), or `skipped`. Up to `max_replies` calls per voice message.
- **Shown on the device:** a successful call emits a `reply` event for the interaction with `body` and `glance` set to the spoken text (without tags) and `spoken: true`. The Compact's Understood screen already shows the latest `reply` event's body (at most 120 characters, else glance), so no firmware change is needed. Once an interaction has a spoken answer, a later `reply()` still emits its `reply` event, but with the spoken text as `body`/`glance` (and `more_on_telegram: true`), so Understood keeps the spoken answer; the real reply reaches the Thread and Telegram as usual.
- **Recorded:** the tool also posts `🔊 text` (tags removed) as a silent agent message in the followed conversation (`metadata.intercom_spoken: true`), mirroring the `🎙️` echo: it appears in the Thread (`conversation_append`), the transcript, journaling and Telegram. The bus does not turn that record into a `reply` event or speak it.
- **Fallback auto-speech.** `voice.speech.fallback` (default true): if no `speak` call has arrived by `voice.speech.fallback_grace_s` (default 3 s) after the first `reply` of a voice message, the bus speaks that reply's body when short, else its glance (the rule under "Spoken replies"). A `speak` call inside the grace cancels it. Once `speak` has been used for a message, replies are never auto-spoken. With `fallback: false`, nothing is spoken unless the agent calls `speak`. Log: `{"evt":"speech_fallback",...}`.
- **Voice style guide.** `voice.speech.style_file` names a Markdown file read fresh from disk on each voice message. Pipeline stage 89 (`voice-style-inject`) attaches its content as a system block (`<agentbus-system kind="voice-style">`, before the per-message note) only the first time a given agent session receives a voice message, and again when the file's SHA-256 changes. Session identity is the bus session (`sessions.id`, replaced by `/clear` or an idle cut) plus the route's pane, so a new session, a reset or another pane injects again; state is in table `voice_style_injections` and survives a bus restart. Limits: the bus cannot see Claude's own context compaction, so a guide compacted away returns only on the next session, pane change or file edit; and it is marked delivered when the message is enqueued, not when the pane takes it. Every voice message also carries a short per-message note: the text is a speech transcript, call `speak(message_id, text)` first, then `reply()` for anything longer.

### Push-to-talk audio (E92)

A surface (the Compact while BOOT is held) streams its microphone over the same socket; the bus transcribes it and sends the text into the followed conversation exactly as a typed `send` with the same `client_msg_id`. Works on protocol v1 and v2. Source: `src/intercom/voice.ts`.

| Frame | Direction | Meaning |
|---|---|---|
| `{"type":"audio_start","client_msg_id","rate?":16000,"format?":"pcm_s16le"}` | device → bus | Opens a recording on this socket (replacing any open one). `client_msg_id` 1-100 characters, unique per utterance, and becomes the send's id. `rate` 8000-48000 (default 16000); only `pcm_s16le` (16-bit little-endian mono) is accepted. A malformed frame answers `error` / `invalid_frame` |
| binary frames | device → bus | Raw PCM for the open recording, any size (the Compact sends 100 ms, 3,200 bytes). Ignored when no recording is open. A binary first frame closes the socket with 4401 |
| `{"type":"audio_end","client_msg_id"}` | device → bus | Release: transcribe and send |
| `{"type":"audio_cancel","client_msg_id"}` | device → bus | Drop the recording; nothing is transcribed or sent |
| `{"type":"transcript","client_msg_id","final":false,"text"}` | bus → device | Interim transcript of the audio so far, while the button is held (at most one per `voice.partial_interval_ms`, only after at least 0.8 s of new audio) |
| `{"type":"transcript","client_msg_id","final":true,"status","text?","reason?","duration_ms?"}` | bus → device | The answer to `audio_end`. `ok` with `text`, then the usual `ack` for the send follows (`queued`, `rejected` or `command`, exactly as for `send`); `empty` (shorter than `voice.min_ms`, quieter than `voice.silence_peak`, or nothing recognised); `failed` with `reason` `unavailable` (no engine), `stt_error`, `timeout` (no audio for `voice.idle_timeout_ms`) or `no_recording` (no open recording with that id) |

- The send carries metadata `input: "voice"` and `transcript_engine`, the agent's Intercom note gains one line saying the text is a speech transcript, and the Telegram echo reads `🎙️ text` instead of `⌨️ text`. Idempotency, dedup, the interaction window and the `reply` events are those of `send`.
- A `read_only` device gets `error` / `read_only` for the three frames.
- **Bounds.** Audio past `voice.max_seconds` (60) is dropped; the recording is still transcribed. Audio lives in memory only and is gone once transcribed or dropped; nothing is written to disk except the command engine's temporary WAV, removed after the run. A socket that closes drops its recording, and a transcription still running for it is discarded.
- **Latency mark.** `[intercom] {"evt":"latency","mark":"transcript_final","client_msg_id","ms","audio_ms","chars"}`, `ms` from `audio_end` to the final transcript.
- **Engines** (`adapters.intercom.voice`, see [INTERCOM.md](INTERCOM.md#configure-the-bus)): `elevenlabs` posts to ElevenLabs Scribe, `<base_url>/v1/speech-to-text` (default model `scribe_v2`, key from `voice.elevenlabs.api_key_env`, `ELEVENLABS_API_KEY`), sending 16 kHz recordings as raw PCM (`file_format: pcm_s16le_16`) with `language_code` and any `keyterms`; `openai` posts a WAV to `<base_url>/audio/transcriptions` (default model `gpt-4o-mini-transcribe`, about 1.5 s for a short clip) with the key from the env var `voice.openai.api_key_env` (`OPENAI_API_KEY`); `command` runs `voice.command.argv` without a shell (`{wav}` is the path of a temporary 16-bit mono WAV, `{lang}` the language) and reads the transcript from stdout. `auto` (default) uses ElevenLabs when its key is set, else OpenAI, else the command, else voice answers `unavailable`. OpenAI retires `gpt-4o-mini-transcribe` on 2027-02-26; it stays only as a fallback until then. E92's resident local engine (S92.2) and its latency target (S92.3) are not built; a cold `whisper` CLI run takes about 35 s on bobafett, so the command engine suits only a warm local server.

## Actions and jobs

One handler serves `POST /api/v1/surface/actions` and the WS `action` frame.

**Request.**

| Field | Rule |
|---|---|
| `object` | `events:<id>`, `notices:<id>`, `slots:<slot id>` (the primary slot's button) or `conversations:<conversation id>` (id 1-128 characters, no whitespace; no `:` except in a conversation id) |
| `action_id` | `[a-z0-9][a-z0-9_-]{0,31}`; for a notice or a conversation, the button's index (`"0"`, `"1"`, ...) |
| `message_id` | Optional, `conversations:` only: the bus message id the buttons are on (the `id` of the message in the conversation page). Default: the newest open prompt in the conversation |
| `idempotency_key` | 1-100 characters, generated by the device, unique per tap. A retry of the same tap reuses it |
| `draft` | Required, and must match exactly, when the action has `confirm.draft` (at most 2,000) |

**Order of checks.** Malformed request: `failed` / `invalid` (not remembered). Read-only device: `read_only`. More than `action_rate_limit_per_min` actions from this device in the last 60 s: `rate_limited`. Then requests are serialised per (surface, key), and a remembered key answers from memory.

**Idempotency.** Keys are scoped to the surface (not the device) and remembered for `action_key_ttl_hours`. A repeat of a key whose first answer was `done` (or `already_done`) answers `already_done` with the first `message_id`; a repeat of any other remembered outcome replays it. Concurrent duplicates fire once. `internal_error` is never remembered, so the same key may retry.

**Event actions** (`events:<id>`). A job is the scheduler's item shape with `trigger: action`, stored in `surface_jobs` under `events:<event id>:<action id>`, with `channel`, `sender`, `topic` (default `general`), `payload_body`, `sends_on_behalf`, `confirm_draft`, `once`, `expires_at`. When it fires, the payload is injected into the inbound pipeline as the scheduler injects a fire: a text message from `sender` on `channel`/`topic`, with metadata `origin: surface_action`, `surface_id`, `device_id`, `object`, `action_id`, `job_id` and `idempotency_key`.

- **One-shot.** `once` jobs (the default) fire at most once across all keys; later taps answer `already_done`. Replacing an Event's jobs keeps the fire count of an action id that survives, so editing an Event cannot re-arm a button that already fired.
- **Expiry.** A tap after the job's or the Event's `expires_at` answers `expired`.
- **Ended Events (E100).** A tap on a tombstone answers `expired` with `reason` set to its state (`expired`, `withdrawn`, `answered` or `cleared`), whatever the job says; nothing fires. `expired` was chosen over a new status so clients that predate E100 show it as Expired and disable the button.
- **Auto-answer (E100).** When a button on a **decision or urgent** Event (by `weight`, or without one by `level` `attention` or `urgent`) fires with result `done`, the Event becomes an `answered` tombstone. Only the version that was tapped is ended (same `updated_at`, still open), so a re-publish in between survives. Ambient and notice Events stay open when their buttons are tapped. Slot buttons have no lifecycle.
- **`confirm.draft`.** A job that sends on Chris's behalf must store a draft (the job store refuses one without). It fires only when the Event's button shows the same `confirm.draft` and the device echoes it in `draft`. A sends-on-behalf job whose button has no draft, or whose stored and shown drafts differ, never fires (`confirm_required`). For any action with a draft: no `draft` in the request answers `confirm_required`, a different one `draft_mismatch`.
- **Fired hook.** When an Event button's tap answers `done`, or `already_done` because its `once` job fired earlier (not a replayed key, not a slot button), the handler calls `onEventFired({surfaceId, eventId, actionId, label})` (`ActionHandlerDeps`, wired in `src/surface/runtime.ts` to `IntercomService.noteEventFired`). It is best effort: a throw is logged and never changes the result. The Intercom service uses it for the commute "on my way" flag ([INTERCOM.md](INTERCOM.md)).
- **Result.** Queued for an agent: `done` with `message_id`. Accepted but routed nowhere: `failed` / `no_route`. A slash command the bus handled: `done`. A pipeline abort: `failed` with its reason. A thrown pipeline error: `internal_error`, and the job is un-claimed so the same key can retry.

**Notice actions** (`notices:<id>`, action id = index) go through the E89 `notification_action` path: the notification is acknowledged and `[tapped] <label>` is sent into the followed conversation like a surface send, with the idempotency key as `client_msg_id`. `queued` or `command` answers `done`; an unknown, terminal or untargeted notice `not_found`; a bad index `invalid`. See [NOTIFICATIONS.md](NOTIFICATIONS.md#surface-api-v2-e96).

**Slot actions** (`slots:<slot id>`). The primary slot's button works exactly like an Event button: one job in `surface_jobs` under `slots:<slot id>:<action id>`, created in the same transaction as the slot, replaced when the slot is set again (keeping the fire count of a surviving action id), removed when the slot is cleared (`DELETE slots/:slot` answers `jobs_removed`) or replaced by a slot without an action. The job expires with the slot (`until`); a tap after that answers `expired`, and the job is kept a day like an Event's so a late tap is not `not_found`. One-shot, expiry and `confirm.draft` rules are the Event rules.

**Conversation actions** (`conversations:<conversation id>`, action id = the button `index` shown in the conversation page (`GET /conversations/:id`)). A tap behaves like a Telegram tap on the same prompt (`resolveChoiceTap`): the prompt must be open and addressed to the surface's contact (or to nobody); the `open` to `answered` flip is atomic, so a double tap answers once; the pick is injected into the prompt's conversation as the followed contact (`[tapped] <label>`, or the choice's slash command), with `reply_to` the question, the choice metadata Telegram attaches (`choice_prompt_id`, `choice_index`, `choice_label`) and `origin: surface_action`; the conversation's `answer_needed` flag is cleared and the `sessions` resource updated; the prompt's Telegram keyboard is cleared (best effort). If the injection fails the prompt is reopened so the button can be tapped again (`internal_error`). The surface must be allowed to read the conversation (the one it follows, or one in its `sessions`), else `not_found`. Results: `done`; `already_done` (answered elsewhere or by an earlier key); `expired` (prompt past its expiry); `failed` with `invalid` (index out of range, or a copy/link button, which cannot be tapped from a surface), `forbidden` (prompt addressed to another contact), `not_found` (nothing open, unreadable conversation) or `no_route`. Device and read-only checks, rate limit and idempotency are the shared ones above.

**Approval actions** (`events:approval-<id>`, action `approve` or `deny`) resolve the bus approval (see [Approvals](#approvals)).

**Results.**

| `status` | `reason` | When |
|---|---|---|
| `done` | | Fired (or approval answered by this tap); `message_id` when a message was injected |
| `already_done` | | A `once` action already fired, the key was already answered `done`, or the approval was answered elsewhere |
| `expired` | | The job, Event or approval expired |
| `expired` | `expired` \| `withdrawn` \| `answered` \| `cleared` | E100: the Event has ended (a tombstone); the reason is its state |
| `failed` | `invalid` | Malformed request (HTTP 400) |
| `failed` | `read_only` | Read-only device (HTTP 403) |
| `failed` | `rate_limited` | Over `action_rate_limit_per_min` (HTTP 429) |
| `failed` | `not_found` | No such Event, slot, action, job, notice, open prompt or (addressed) approval |
| `failed` | `forbidden` | A conversation prompt is addressed to another contact |
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

- id `approval-<approval id>`, `level: attention`, `weight: decision`, `state: open`, `expires_at` = the approval's expiry, `source: bus`;
- title `<tool>: <summary>` (self-edit: `Proposed change`), body `Agent <id> · <conversation title> asks to use <tool>.`;
- actions `approve` (primary) and `deny` (destructive), both one-shot and `kind: hold`;
- `approval.detail` = exactly what is being approved: `raw_context.details` when a backend supplied one, else the full shell command (`tool_input.command`), else the summary. Cut to 2,000 characters with `… [N more characters]`.

The set is synced on the 5-second tick and right after a device answers; agent-published Events are never touched. An approval that is no longer pending becomes a tombstone (E100): `answered` when approved or denied (`ended_at` = `resolved_at`), `expired` when it expired, `withdrawn` when it went stale or is gone from the table. Later syncs leave tombstones alone; the sweep purges them. Approve or Deny resolves through `resolveApproval()`, the same path the Telegram buttons and `POST /api/v1/approvals/:id/resolve` use, so staleness, expiry, the in-flight guard, the pane keystroke and the `onResolved` hooks are identical. `resolved_by` is `device:<device id>`. Another contact's approval answers `not_found`. The Telegram message's buttons are removed by the approvals sweep. See [APPROVALS.md](APPROVALS.md#approving-from-a-surface-e96).

## Moment lifecycle (E100)

Every `events` item is a Moment with a bus-owned `state` (`src/surface/lifecycle.ts`):

| Transition | How | `ended_at` |
|---|---|---|
| → `open` | Every publish (create or replace). Re-publishing an id that has ended starts a new life: `201`, `created: true`, `revived: true`, a new `created_at`, no `ended_at`, and fresh jobs (fire counts reset, so a one-shot button that fired in the old life is armed again) | removed |
| `open` → `withdrawn`, `answered`, `cleared` | `DELETE :surface/events/:id?reason=` (`surface_remove_event`), default `withdrawn` | now |
| `open` → `expired` | The 60 s sweep, once `expires_at` has passed | `expires_at` |
| `open` → `answered` | A button on a decision or urgent Event fired with `done` (see [Actions and jobs](#actions-and-jobs)); an approval answered anywhere | now; for an approval its `resolved_at` |
| `open` → `withdrawn` (approval) | The approval went stale or vanished | resolution time or now |
| tombstone → gone | The sweep, `event_tombstone_hours` (default 24) after `ended_at` | |

**Tombstones** are terminal Events kept in `events` with their content, `state` and `ended_at` (and `updated_at` = the change time), so a device can show them in an Earlier tray with the right word. They do not count toward `eventsPerSurface`, never block the ring-overlap check, are never re-expired, and their buttons answer `expired` with the state as `reason`. An agent may not change a tombstone except by publishing the id again.

**Deltas.** Every transition is a `set` op carrying the whole item with its new state (open → expired is a `set`, not a `remove`), logged like any change, so resume replays it and `GET /state` equals what a connected device holds. Only the purge is a `remove`.

**Clients.** A client that predates E100 should treat any Event whose `state` is present and not `open` as gone (the main web app drops them from its store). Items stored before E100 carry no `state` and read as `open`; nothing is migrated: the sweep turns them into tombstones when they expire.

## Answer needed

A per-conversation flag (`surface_answer_needed`, one per conversation: a newer question replaces the older one) that marks a question the agent is waiting on.

- **Set** by `reply` / `send_message` with `answer_needed` (S96.5, see [below](#agent-publishing-tools-s965)).
- **Cleared** by a choice-button tap on that conversation's prompt (when the tap is answered), by a message from the contact in that conversation (scheduled fires, `system_only` turns and `agent:` or `system:` senders do not clear it), or by the explicit clear tool. A clear pushes a `sessions` update at once.
- **Shown** as `needs_you` / `needs_you_message_id` in `sessions`, and as `answer_needed: true` on the question message in the conversation page and live appends.

## Faces

At startup each surface with an empty `faces` resource is seeded with `day` (order 0), `status` (1) and `desk` (2), all enabled, without a layout. An agent can change an existing face with `surface_set_face` (`PUT faces/:id`): `enabled`, `order` (0-99) and `layout`. It cannot create faces: a face is something the firmware or web app knows how to draw.

`layout` is optional. Absent, the device's built-in layout for that face applies (a Compact's firmware draws the Day Dial the same way whether or not a layout is set). Present, it is exactly:

```json
{ "slots": { "event_ring": true, "primary": true, "context": "lines" } }
```

`event_ring` and `primary` are booleans (draw the ring events; show the primary slot, default the next Event), `context` is `"lines"` or `"widgets"` (which form of the `context` slot the face binds). Any other key is refused. `layout: null` in the tool removes it. Bigger layouts (positions, sizes) are deliberately not modelled here; they belong to a later custom-face epic.

## Assets upload

`POST /api/v1/surface-publish/assets?agent_id=<agent>` (tool `surface_upload_asset`). The body is the raw file, with `Content-Type` `image/png`, `image/jpeg` or `image/svg+xml` (a QR code is just a small PNG). Behind the shared bus token like the other publishing routes, and the agent must be a publisher of at least one surface (`403` otherwise); devices never reach this prefix (the TLS listener serves only `/api/v1/surface`). The bytes must match the declared type (PNG and JPEG signatures; SVG must be a static `<svg>` document: script, event handlers, `foreignObject`, `iframe`, `embed`, `object`, `javascript:` and entities are refused), and the size is limited by `surface_api.asset_max_bytes` (`413` over). The file is stored as `<directory of bus.db_path>/surface-assets/<sha256>.<png|jpg|svg>`, written to a temporary name and renamed, so the same bytes always give the same hash. Answer: `201` (new) or `200` (already stored) with `{ok, hash, reference, content_type, size, url, created}`; use `hash` as `detail.image` of an Event. `415` for another content type, `400` for bad bytes. Devices fetch it with `GET /api/v1/surface/assets/<hash>`. Nothing deletes assets yet; remove files by hand.

## Notices

The `notices` resource mirrors the surface's open E89 notifications (`active` and `acknowledged`, targeted at the surface or `*`), keyed by notification id, in the public notification shape. It is synced at startup and on every notification create, update, state change and expiry. With `notifications.enabled: false` it is empty. The v1 `notification` and `attention` events continue alongside it.

## Device resource

Each device that has connected has an item in its surface's `device` resource. It is patched on connect (`connected: true`), when the device's last socket closes (`connected: false`), on `state` frames (`quiet`, `battery`) and on `view` frames. Every device on the surface sees every other device's item. Items are not removed when a device is revoked.

## Sweeps and ticks

| Cadence | Work |
|---|---|
| Every 5 s (the service's desk tick) | Close sockets of revoked devices (4403); recompute `sessions`; sync approval Events |
| Every 60 s (surface runtime) | Turn open Events past `expires_at` into `expired` tombstones (`ended_at` = `expires_at`; one already older than `event_tombstone_hours` is removed outright), remove tombstones whose `ended_at` is more than `event_tombstone_hours` ago, and remove slots past `until` (all through the store, so devices get deltas); delete jobs expired more than a day ago (they are kept until then so a late tap answers `expired`, not `not_found`); delete idempotency keys older than `action_key_ttl_hours`; delete v2 pairing codes spent or expired more than a day ago |
| Every 60 s (notifications) | Expire due notifications, which updates `notices` |
| Hourly (service) | v1 durable-event retention and v1 pairing codes, as before |

## Deviations and not yet reconciled

- **Object shapes were defined here, then reconciled.** E96 was built without `architecture.md` section 3; the follow-on (event shape, slots, faces, assets) brought the shapes in line with it. Where this implementation intentionally differs from the design, [SURFACE_API_CHANGES.md](SURFACE_API_CHANGES.md) lists it.
- **Push-to-talk** (E92) is built without S92.2 (a resident local engine), S92.3 (the latency target) or S92.5 (the sample bank); audio is not kept 24 hours (S92.4 said it would be): it is dropped as soon as it is transcribed.
- **Assets are never deleted** and the store has no listing route.
- **Widgets are data only.** There is no reactive key store and no sandboxed code; the slot-to-widget binding (`context.widgets`) is the only coupling.
- **v1 re-pairing creates a device each time.** A phone that loses its stored token and pairs again with a v1 code gets a new device; after `max_devices` of them the code answers `409 device_limit` (which the v1 web app does not explain). Revoke stale devices with `scripts/surface-devices.ts`.

## Agent publishing tools (S96.5)

Agents publish through MCP tools, registered for cc-pool panes, Claude Code and cc-headless instances. Each tool calls a bus route under `/api/v1/surface-publish/` on the main port, behind the usual `X-Bus-Token`; the agent names itself with `agent_id` (body for `PUT`/`POST`, query for `GET`/`DELETE`). The bus's error message is returned to the agent verbatim.

**Authorisation.** The agent must be listed in the surface's `publishers` (`adapters.intercom.surfaces[].publishers`; `*` allows any agent; empty means nobody). A pool pane such as `peggy-pool-3` counts as `peggy`. Otherwise `403` names the config key; an unknown surface `404` lists the surfaces the agent may publish to.

| Tool | Route | What |
|---|---|---|
| `list_surfaces` | `GET surfaces?agent_id=` | Surfaces this agent may publish to, with their follow target |
| `surface_publish_event` | `PUT :surface/events/:id` | Create or replace an Event (`201` new or revived from a tombstone, `200` replaced with `created_at` kept). Answer: `{surface, id, created, revived?, state: "open", rev, expires_at, actions, kinds}` (`kinds`: action id → resolved `tap`/`hold`) |
| `surface_remove_event` | `DELETE :surface/events/:id?reason=` | End an Event (E100): it becomes a tombstone with `state` = `reason` (`withdrawn` default, `answered`, `cleared`) and its jobs are removed. Answer: `{surface, id, removed, state?, jobs_removed, rev?}`; `removed` is false for an unknown id or one already ended (left as it is; `state` is its current state). Another reason answers `400` |
| `surface_set_slot` | `PUT :surface/slots/:slot` | Override a face slot until `until`; `primary` may carry an `action`, `context` takes `lines` or `widgets` |
| `surface_clear_slot` | `DELETE :surface/slots/:slot` | End the override (and remove the job behind its button) |
| `surface_set_face` | `PUT :surface/faces/:id` | Enable, reorder or give an existing face a `layout` |
| `surface_upload_asset` | `POST assets` | Upload a PNG, JPEG or static SVG (raw body); returns the hash for `detail.image` |
| `surface_write_widget` | `PUT :surface/widgets/:id` | Write a widget's `type` and `data` |
| `surface_remove_widget` | `DELETE :surface/widgets/:id` | Remove a widget |
| `clear_answer_needed` | `POST answer-needed/clear` | Clear a conversation's flag (`conversation_id`, or `channel` + `contact` + `topic`; with no arguments cc-headless uses its turn's conversation) |

**Event input.** `{id, title, body?, weight?, level?, consequence?, changed?, at?, end?, layer?, color?, travel?, detail?, opens?, conversation_id?, expires_at?, actions?}` (the ring and Moment fields are described under [Object shapes](#object-shapes)). Give `weight` or `level`: with only `weight` the level is derived (ambient/notice → info, decision → attention, urgent → urgent); with only `level` no weight is stored; with both they must agree under that mapping or the call answers `400` naming both values. `consequence` and `changed` are refused (`400`) unless the event is urgent. `state` and `ended_at` are bus-owned and refused. Each action may carry `kind` (`tap` or `hold`, rules under [Object shapes](#object-shapes)). `expires_at` defaults to 24 hours ahead and must be in the future and at most 14 days ahead. Each action is `{id, label, style?, confirm?: {draft, prompt?}, once? (default true), run: {body, sends_on_behalf?}}`: `run.body` is the message injected into the surface's followed conversation (as the followed contact, like a scheduled fire) when the button is tapped. `sends_on_behalf: true` requires `confirm.draft`. Jobs always target the follow conversation. Editing an Event keeps the fire count of actions whose id survives, so a fired one-shot button is not re-armed. Agents cannot write `kind: approval` or change bus-owned Events. Every bound in [Bounds](#bounds) is checked and an over-limit call answers `400` with a message naming the field and the limit, and nothing is written (the jobs and the Event are written in one transaction).

**`answer_needed`** on `reply` and `send_message` (next to `choices`): stored as `metadata.answer_needed`; when true on agent-sent text, `POST /api/v1/messages` sets the conversation's flag (the reply's conversation, else the bound `metadata.conversation_id`, else the hash of recipient, channel and topic). A message without it never sets the flag. See [Answer needed](#answer-needed).

**`status(subject)`**: an optional line (at most 60 characters, sanitised like the status text) saying what the whole session is about. cc-headless's stream parser and the pool's tool-status hook post it with the status line to `POST /api/v1/adapters/:id/tool-status`, which stores it for the conversation (`conversation_id` when given, else the pool lease with that Claude `session_id`, else the hash of contact, channel and topic). Limitation: cc-headless ignores tool calls after the reply is delivered, so a `subject` set after the reply is lost there; the pool hook still posts it.

## Migration note: AgentBus to Intercom rename

The v2 paths live under `/api/v1/surface` deliberately: the name is product-neutral, so the planned rename of AgentBus to Intercom does not move them again. `/api/v1/intercom/*` stays as an alias (same handlers, same credentials, same WebSocket handler with protocol v2 available) until the web prototype migrates to `/api/v1/surface` in E97. Clients written now should use `/api/v1/surface`.
