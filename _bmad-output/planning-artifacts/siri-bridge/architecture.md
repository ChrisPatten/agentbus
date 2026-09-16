# Siri Bridge — Architecture

**Version:** 1.0 · **Status:** Approved · **BMAD Phase:** 3 — Architecture · **Parent:** `_bmad-output/planning-artifacts/architecture.md` · **Date:** 2026-09-14

This document is the source of truth for *specifics*: file paths, class names, HTTP contracts, config keys, SQL, Swift types. Epics reference sections by number. Where an Apple API is iOS 26/27-new, it is marked **[verify in Xcode 27 SDK]** — the dev agent must confirm the exact signature against the SDK headers before relying on it, and record any deviation in `spike-results.md`.

---

## Table of contents

1. System overview
2. Alignment with AgentBus principles
3. Bus: the `siri` channel adapter
4. Bus: HTTP contract
5. Bus: config schema
6. Bus: database migration
7. Bus: pipeline interactions and Peggy's prompt contract
8. Latency budget and tuning knobs
9. Network exposure and TLS
10. Security and privacy
11. Bus: observability
12. iOS app: Peggy
13. Phase 3: Peggy as a Siri AI source
14. Testing strategy
15. Source tree changes
16. Architecture decision records
17. Spikes and open questions

---

## 1. System overview

```
┌──────────────────────────────── iPhone (iOS 27) ───────────────────────────────┐
│  "Hey Siri, ask Peggy …"                                                       │
│      │  Siri / Siri AI resolves the App Shortcut, fills `question`             │
│      ▼                                                                         │
│  Peggy.app  (runs in background, never foregrounded by the intent)             │
│   ├─ AskPeggyIntent.perform()                                                  │
│   ├─ BusClient (URLSession)  ──── HTTPS over Tailscale ───────────────┐        │
│   ├─ Settings (UserDefaults) + Keychain (tokens)                      │        │
│   ├─ BackgroundReplyFetcher (background URLSession → local notif)     │        │
│   └─ SwiftData history                                                │        │
└───────────────────────────────────────────────────────────────────────┼────────┘
                                                                        │
┌──────────────────────────────── Mac mini ─────────────────────────────┼────────┐
│  tailscale serve  https://mini.<tailnet>.ts.net/api/v1/siri ──▶ 127.0.0.1:3000 │
│                                                                        │        │
│  bus-core (Fastify)                                                    ▼        │
│   ├─ src/http/siri-routes.ts   POST /api/v1/siri/ask ─▶ processInbound() ─▶ pipeline ─▶ message_queue
│   │                             GET  /api/v1/siri/replies/:id (long-poll)       │           │
│   │                             GET  /api/v1/siri/requests, /health             │           │ poll (agent:peggy)
│   ├─ src/adapters/siri.ts      SiriAdapter (AdapterInstance, channels:['siri'])│           ▼
│   │      waiters: Map<message_id, Waiter>  +  siri_requests table (durable)     │   cc-headless (claude -p --resume)
│   │      send(envelope) ◀── DeliveryWorker (dequeueByPrefix 'contact:')         │           │ `reply` MCP tool
│   │                                     ▲                                        │           ▼
│   └─ POST /api/v1/messages ◀────────────┴──────────────────────────────── cc.ts (AGENTBUS_TOOLS_ONLY)
└─────────────────────────────────────────────────────────────────────────────────┘
```

Everything to the right of the HTTP boundary already exists except `siri-routes.ts`, `siri.ts`, one migration, and config keys. The bus does not learn anything new about Peggy; Peggy does not learn anything new about the bus beyond a prompt paragraph.

---

## 2. Alignment with AgentBus principles

| Principle | How the design complies |
|---|---|
| Deterministic routing | `pipeline.routes` `match.channel: siri` picks the agent; nothing infers intent |
| No content generation in the core | The adapter never calls a model; fallback re-delivery is a templated copy of Peggy's own reply |
| Agents are autonomous; bus is a courier | Peggy decides what to say; the adapter only holds an HTTP request open until her reply arrives |
| Explicit over implicit | Channel enabled by config; token per contact; fallback channel named explicitly |
| Identity resolution is a bus concern | Bearer token → `contact:<id>` before the pipeline runs (E25 pattern) |
| Protocol translation, not semantic | HTTP request/response ⇄ `MessageEnvelope`; no interpretation |
| Loose coupling via MCP | Peggy still replies with the `reply` tool; no new tool needed |

Boundary test: "Does it work the same regardless of which agent is connected?" → yes; route the `siri` channel at any agent and it works.

---

## 3. Bus: the `siri` channel adapter

### 3.1 Why a full `AdapterInstance` (unlike Pebble)

Pebble is receive-only, so E25 registered a bare route. Siri is request/response: the reply must find its way back to a specific waiting HTTP request. `DeliveryWorker` already dispatches every `contact:*` outbound message to `registry.lookupPrimaryByChannel(envelope.channel)` — so registering a `SiriAdapter` with `capabilities.channels: ['siri']` makes the existing delivery loop deliver Peggy's reply straight into our `send()`. No changes to `DeliveryWorker`, `reply`, or `cc-headless`.

### 3.2 `src/adapters/siri.ts`

```ts
import type Database from 'better-sqlite3';
import type { MessageEnvelope } from '../types/envelope.js';
import type { AdapterInstance, AdapterCapabilities, DeliveryResult, HealthStatus } from '../core/registry.js';
import type { MessageQueue } from '../core/queue.js';
import type { SiriAdapterConfig } from '../config/schema.js';

export type SiriRequestStatus = 'pending' | 'answered' | 'claimed' | 'expired' | 'failed';

export interface SiriRequestRecord {
  request_id: string;        // client idempotency key (uuid) or server-generated
  message_id: string;        // inbound envelope id from processInbound()
  contact_id: string;        // 'contact:chris'
  text: string;
  status: SiriRequestStatus;
  created_at: string;        // ISO
  queued_at: string;         // ISO — after processInbound returned
  answered_at: string | null;
  claimed_at: string | null;
  reply_message_id: string | null;
  reply_body: string | null; // first reply; extras appended to extra_replies (JSON array)
  extra_replies: string;     // JSON string[]
  status_lines: string;      // JSON string[] — reportToolCall lines (FR-14)
  client: string;            // JSON {device, app_version, locale}
  timed_out: 0 | 1;          // the original POST /ask returned pending
}

interface Waiter {
  requestId: string;
  resolve: (r: SiriRequestRecord) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SiriAdapter implements AdapterInstance {
  readonly id = 'siri';
  readonly name = 'Siri';
  readonly capabilities: AdapterCapabilities = {
    send: true,
    typing: false,
    toolStatus: true,          // reportToolCall → status_lines (Phase 3 consumer)
    maxMessageLength: 4000,
    channels: ['siri'],
  };

  private readonly waiters = new Map<string, Waiter>();     // key: message_id
  private readonly inFlightByKey = new Map<string, string>(); // `${contact_id}\n${text}` → request_id (dedup join, FR-7)

  constructor(private readonly deps: { db: Database.Database; queue: MessageQueue; cfg: SiriAdapterConfig;
    contactsByToken: Map<string, string>; registryLookup: (channel: string) => boolean }) {}

  async start(): Promise<void> { /* re-hydrate: any 'pending' rows keep waiting via GET /replies; nothing to do in memory */ }
  async stop(): Promise<void>  { for (const w of this.waiters.values()) clearTimeout(w.timer); this.waiters.clear(); }
  async health(): Promise<HealthStatus> { return { status: 'healthy', details: { pending: this.waiters.size } }; }

  /** Called by the route after processInbound() succeeded. Returns a promise that resolves on reply or timeout. */
  awaitReply(rec: SiriRequestRecord, waitMs: number): Promise<SiriRequestRecord | null> { /* register waiter keyed by rec.message_id */ }

  /** DeliveryWorker → here. Correlate on reply_to; fall back to oldest pending for the recipient. */
  async send(envelope: MessageEnvelope): Promise<DeliveryResult> {
    const rec = this.matchRequest(envelope);           // by reply_to, else oldest pending for envelope.recipient
    if (!rec) { this.storeUnsolicited(envelope); return { success: true, platformMessageId: envelope.id }; }
    const first = rec.status === 'pending';
    this.recordReply(rec, envelope, first);            // UPDATE siri_requests … (answered_at, reply_body | extra_replies)
    const w = this.waiters.get(rec.message_id);
    if (w) { clearTimeout(w.timer); this.waiters.delete(rec.message_id); w.resolve(this.load(rec.request_id)); }
    else if (first && rec.timed_out && this.deps.cfg.fallback) this.enqueueFallback(rec, envelope); // FR-6
    return { success: true, platformMessageId: envelope.id };   // never retryable: nothing external can fail here
  }

  reportToolCall(contactId: string, text: string): void { /* append to status_lines of the newest pending request for contactId */ }

  private enqueueFallback(rec: SiriRequestRecord, reply: MessageEnvelope): void {
    const body = renderTemplate(this.deps.cfg.fallback!.template, { body: reply.payload.body, question: rec.text });
    this.deps.queue.enqueue({
      id: randomUUID(), timestamp: new Date().toISOString(),
      channel: this.deps.cfg.fallback!.channel, topic: 'general',
      sender: reply.sender, recipient: rec.contact_id, reply_to: null, priority: 'normal',
      payload: { type: 'text', body }, metadata: { source: 'siri-fallback', siri_request_id: rec.request_id },
    });
  }
}
```

Rules the implementation must keep:
- `send()` is idempotent per reply message id (DeliveryWorker never retries, but be safe).
- `matchRequest`: `reply_to` first; if null, the oldest `pending` request for `envelope.recipient` created within the last `reply_timeout_ms × 4` (the cc-headless stdout fallback posts with `reply_to = original.id`, so the null case is rare).
- An unsolicited Peggy message on channel `siri` (e.g. `send_message` to `siri` proactively) is stored as a request-less reply (`request_id = 'unsolicited:' + envelope.id`, status `answered`) so the app history can show it; if `fallback` is configured it is re-delivered there as well.
- `renderTemplate` reuses `src/adapters/prompt-renderer.ts` `{{var}}` substitution (same as channel relay).

### 3.3 `src/http/siri-routes.ts`

Registered from `createHttpServer` when `config.adapters.siri?.enabled`, mirroring the Pebble block. Exports `registerSiriRoutes(server, deps)` where `deps` adds `siri: SiriAdapter`.

Request lifecycle for `POST /api/v1/siri/ask`:

```
1. body-size guard (413) → auth (401) → validate body with zod (400) → rate limit (429)
2. request_id := body.request_id ?? randomUUID(); if a row exists with this request_id → return its current state (idempotent replay)
3. dedup-join check: key = contact_id + '\n' + text; if inFlightByKey has key → attach to that request (skip 4–5)
4. INSERT siri_requests (status 'pending', created_at)
5. processInbound({ channel:'siri', sender:'contact:<id>', payload:{type:'text', body:text}, metadata:{source:'siri', request_id, client, sent_at} })
     - queued:true  → UPDATE message_id, queued_at
     - queued:false reason 'duplicate' → if inFlightByKey has key → attach; else mark 'failed', return 409
     - queued:false reason 'command_handled' → return 200 {status:'answered', reply:{body:<command response>}}  (slash commands like /status still work by voice: "Ask Peggy: slash status" is unlikely; supported for completeness)
     - queued:false other → 'failed', 503 { error: reason }
6. if config.adapters.siri.debug_delay_ms > 0 → await sleep(debug_delay_ms)   (E44 only)
7. rec = await siri.awaitReply(rec, min(wait_ms ?? reply_timeout_ms, reply_timeout_ms))
8. answered → 200 {status:'answered', …} ; timeout → UPDATE timed_out=1 → 200 {status:'pending', …}
```

`GET /api/v1/siri/replies/:request_id?wait_ms=`: auth → load row (404 if missing/expired or not this contact) → if `answered`/`claimed` return immediately and set `claimed` → else register a waiter on its `message_id` for `min(wait_ms, reply_timeout_ms)` → return answered or `{status:'pending'}`.

`GET /api/v1/siri/requests`: auth → rows for this contact, newest first, `limit` ≤ 100, `since` ISO.

`GET /api/v1/siri/health`: auth → `{ ok:true, routed: <a pipeline.routes rule matches channel siri>, agent: <its recipientId>, adapters: { [target adapterId]: registry.lookup(...)?'online':'missing' }, version }`.

### 3.4 Sequence — F1 synchronous ask

```
Peggy.app            bus-core (siri-routes)      pipeline/queue        cc-headless (Peggy)       SiriAdapter
   │ POST /ask ─────────▶│                              │                     │                      │
   │                     │ auth, INSERT pending          │                     │                      │
   │                     │ processInbound ──────────────▶│ enqueue (agent:peggy)                      │
   │                     │ awaitReply(msg_id, 20s) ─────────────────────────────────────────────────▶│ waiter
   │                     │                              │◀── poll pending ────│                      │
   │                     │                              │                     │ claude -p … reply()  │
   │                     │                              │◀── POST /messages ──│                      │
   │                     │                              │ DeliveryWorker tick → adapter.send() ──────▶│ resolve
   │◀── 200 answered ────│◀──────────────────────────────────────────────────────────────────────────│
```

### 3.5 Sequence — F2 late reply

```
   │ POST /ask (wait 20s) ▶│ … no reply by 20s … UPDATE timed_out=1
   │◀── 200 pending ───────│
   │ (returns dialog "still working"; schedules background GET /replies/:id?wait_ms=90000)
   │ GET /replies/:id ────▶│ waiter registered (≤ reply_timeout_ms; client re-issues if it expires)
   │                       │           … Peggy replies → DeliveryWorker → SiriAdapter.send():
   │                       │              UPDATE answered; resolve waiter; if fallback configured → queue.enqueue(outbound to bluebubbles)
   │◀── 200 answered ──────│
   │ local notification "Peggy: …"; history updated
```

### 3.6 Restart safety

`siri_requests` is the source of truth. In-memory `waiters` exist only for open HTTP requests, which die with the process anyway; the app's background `GET /replies` simply reconnects. A reply arriving for a request created before a restart still matches by `reply_to` → `message_id` lookup in the table. Expiry: `SiriAdapter.sweepExpired()` on the existing `AttachmentSweeper`-style interval (every 10 min) marks rows older than `late_reply_ttl_ms` as `expired` and deletes them after 2× TTL.

---

## 4. Bus: HTTP contract

All routes are under `/api/v1/siri`. Auth: `Authorization: Bearer <contact siri token>` (+ `X-Bus-Token` if `bus.auth_token` is set). JSON in/out; `ok` convention as in HTTP_API.md.

### `POST /api/v1/siri/ask`

Request:
```json
{
  "text": "What's on my calendar tomorrow?",
  "wait_ms": 20000,
  "request_id": "6C0A9E9B-5C62-4E1B-9B7B-2C4F9E1B3F0A",
  "client": { "device": "iphone", "app_version": "0.1.0", "locale": "en_US" }
}
```
Responses:
```json
// 200 answered
{ "ok": true, "request_id": "…", "message_id": "…", "status": "answered",
  "reply": { "message_id": "…", "body": "Two things: dentist at 9 and the Baxter review at 2.", "received_at": "2026-09-14T14:03:11.402Z" },
  "timing": { "received_at": "…", "queued_at": "…", "answered_at": "…", "queued_ms": 14, "answered_ms": 8931 } }

// 200 pending (server-side wait elapsed)
{ "ok": true, "request_id": "…", "message_id": "…", "status": "pending",
  "timing": { "received_at": "…", "queued_at": "…", "queued_ms": 12, "waited_ms": 20000 } }

// 200 answered (slash command handled inline)
{ "ok": true, "request_id": "…", "status": "answered", "reply": { "body": "bus-core up 3d 2h …" }, "command_handled": true }

// 400 { ok:false, error:"text is required (1..2000 chars)" }
// 401 { ok:false, error:"Unauthorized" }
// 409 { ok:false, error:"duplicate", reason:"duplicate" }     // same text within dedup window and no in-flight request to join
// 413 { ok:false, error:"Request body too large" }
// 429 { ok:false, error:"Rate limited", retry_after_ms: 12000 }
// 503 { ok:false, error:"No route for channel siri" }          // config problem; health reports it too
```

### `GET /api/v1/siri/replies/:request_id?wait_ms=90000`
```json
// 200 answered → same shape as above, plus "extra_replies": ["…"] and "status": "claimed"
// 200 pending  → { ok:true, request_id, status:"pending", waited_ms }
// 404          → { ok:false, error:"Unknown or expired request" }
```

### `GET /api/v1/siri/requests?limit=20&since=2026-09-13T00:00:00Z`
```json
{ "ok": true, "requests": [ { "request_id":"…", "text":"…", "status":"claimed", "created_at":"…", "answered_at":"…",
   "reply_body":"…", "extra_replies":[], "timing": { "queued_ms":14, "answered_ms":8931 }, "client": { "device":"iphone" } } ], "count": 1 }
```

### `GET /api/v1/siri/requests/:request_id`
Single record incl. `status_lines` (Phase 3 progress).

### `GET /api/v1/siri/health`
```json
{ "ok": true, "routed": true, "agent": "agent:peggy", "adapters": { "cc-headless": "online" }, "version": "0.12.0",
  "limits": { "reply_timeout_ms": 25000 } }
```

---

## 5. Bus: config schema (`src/config/schema.ts`)

```ts
const SiriFallbackSchema = z.object({
  channel: z.string().min(1),                       // must resolve to a registered adapter at startup (warn, don't fail)
  template: z.string().default('Re your Siri question "{{question}}":\n{{body}}'),
});

export const SiriAdapterSchema = z.object({
  enabled: z.boolean().default(true),
  reply_timeout_ms: z.number().int().min(1000).max(60000).default(25000),
  late_reply_ttl_ms: z.number().int().positive().default(86_400_000),
  max_body_bytes: z.number().int().positive().default(8192),
  rate_limit: z.object({
    per_minute: z.number().int().positive().default(20),
    max_in_flight: z.number().int().positive().default(4),
  }).default({}),
  fallback: SiriFallbackSchema.optional(),
  /** E44 only — artificial delay before POST /ask responds, to find Siri's cutoff. Refuse to start if > 0 and NODE_ENV=production. */
  debug_delay_ms: z.number().int().nonnegative().default(0),
});
export type SiriAdapterConfig = z.infer<typeof SiriAdapterSchema>;

// ContactPlatformsSchema += 
  siri: z.object({ token: z.string().min(16) }).optional(),

// AppConfigSchema.adapters +=
  siri: SiriAdapterSchema.optional(),

// superRefine: duplicate siri token across contacts → issue at [key,'platforms','siri','token'] (copy the pebble check)
```

`config.yaml.example` gains the block shown in PRD §5 (commented out), and `.env.example` gains `SIRI_TOKEN_CHRIS=`.

---

## 6. Bus: database migration `src/db/migrations/013_siri_requests.sql`

```sql
CREATE TABLE IF NOT EXISTS siri_requests (
  request_id        TEXT PRIMARY KEY,
  message_id        TEXT,                              -- inbound envelope id; NULL until processInbound queued it
  contact_id        TEXT NOT NULL,
  text              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',   -- pending | answered | claimed | expired | failed
  created_at        TEXT NOT NULL,
  queued_at         TEXT,
  answered_at       TEXT,
  claimed_at        TEXT,
  reply_message_id  TEXT,
  reply_body        TEXT,
  extra_replies     TEXT NOT NULL DEFAULT '[]',
  status_lines      TEXT NOT NULL DEFAULT '[]',
  client            TEXT NOT NULL DEFAULT '{}',
  timed_out         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_siri_requests_message ON siri_requests (message_id);
CREATE INDEX IF NOT EXISTS idx_siri_requests_contact_created ON siri_requests (contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_siri_requests_status ON siri_requests (status, created_at);
```

Additive; no changes to existing tables. Follows the `NNN_name.sql` runner convention (`src/db/schema.ts`).

---

## 7. Bus: pipeline interactions and Peggy's prompt contract

- **Envelope** (built by the route, submitted via `processInbound`): `channel:'siri'`, `sender:'contact:<id>'` (already canonical → `contact-resolve` fast path, no change to that stage), `topic:''` → topic-classify assigns per `pipeline.topic_rules` (usually `general`), `metadata: { source:'siri', request_id, client, sent_at }`.
- **Conversation id** = `sha256(sorted([contact_id, 'siri', topic]))` — a distinct long-lived conversation from Telegram/iMessage, so `--resume` gives Siri its own continuity ("and tomorrow?" works) without polluting the Telegram session. Journaling (E20/E30) applies to it like any other headless-managed session.
- **Dedup** (Stage 30): identical text from the same contact within `dedup_window_ms` (30 s default) is dropped — handled by the route's join logic (FR-7).
- **Routing**: `pipeline.routes` rule `match: { channel: siri }` → `target: { adapterId: cc-headless, recipientId: agent:peggy }`. Health endpoint reports `routed:false` when missing.
- **Outbound**: Peggy's `reply` tool → `POST /api/v1/messages` (channel `siri`, `reply_to` = inbound id) → queue → `DeliveryWorker` → `SiriAdapter.send()` → outbound transcript row (E31). Nothing new.
- **Typing/tool-status**: cc-headless fires `POST /api/v1/adapters/siri/typing` (no-op) and `/tool-status` (stored, FR-14).

**Peggy's prompt contract (config, `adapters.cc-headless.<peggy>.system_prompt`)** — add this branch to the existing per-channel length guidance:

```
  - siri*:     You were asked BY VOICE through Siri. Call `reply` exactly once, then stop.
               Answer first, in at most 60 words of plain spoken prose: no markdown, no lists,
               no links, no emoji, no code. Do not say "I'll check" and go quiet — if the task
               needs more than a few seconds of tool use, reply now with what you already know
               and say a fuller answer will follow on iMessage, then continue working and send
               the full answer with `send_message` to bluebubbles.
```

Rationale: the first `reply` is what Siri speaks (FR-4). The "follow on iMessage" behaviour is Peggy's choice, made with her existing tools — the bus does not orchestrate it (principle 3). Journaling stays decoupled (E30).

---

## 8. Latency budget and tuning knobs

| Leg | Typical | Knob |
|---|---|---|
| Siri STT + intent dispatch + app background launch | 1.5–3 s | none (Siri) |
| HTTPS over Tailscale (WireGuard) | 50–150 ms | none |
| `processInbound` + enqueue | < 20 ms | none |
| cc-headless pickup | 0–`poll_interval_ms` | `adapters.cc-headless.<inst>.poll_interval_ms` → **250** for the Peggy instance |
| `claude -p` spawn + CLAUDE.md/memory assembly + first token | **3–10 s (measure)** | fast-lane instance (`model`, `journal_lookback_days: 1`), trimmed CLAUDE.md |
| Model answer + `reply` tool call | 2–10 s | prompt contract (short answers, tools deferred) |
| `POST /messages` → `DeliveryWorker` tick | 0–1000 ms | `DeliveryWorker.POLL_INTERVAL_MS` const → **new `bus.delivery_poll_ms` (default 1000, set 250)** (E45 story) |
| `SiriAdapter.send` → HTTP resolved → Siri TTS | < 0.5 s | none |
| **Total** | **~7–24 s** | budget: app waits 20 s; server cap 25 s |

Contention: cc-headless serializes turns **per contact** (`HeadlessInstance.enqueue`), so a Siri ask queues behind an in-flight Telegram turn for Chris. Options if this shows up in Gate 1 data: (a) dedicated `peggy-siri` instance (own queue), (b) key the queue by conversation for the `siri` channel (small change in `cc-headless.ts`, E45 optional story). Default: (a) only if measured.

---

## 9. Network exposure and TLS

Recommended (same machine, no config change to `bus.host`):
```bash
# On the Mac mini — expose ONLY the siri prefix on the tailnet with a valid LE cert
tailscale serve --bg --https=443 --set-path /api/v1/siri http://127.0.0.1:3000/api/v1/siri
tailscale serve status
# App base URL: https://<mini-hostname>.<tailnet>.ts.net
```
- Tailscale on the iPhone with **Connect on demand** enabled so Siri-triggered intents work on cellular.
- Alternative: existing reverse proxy (Nginx Proxy Manager / Caddy) with a path-scoped location `/api/v1/siri/` → `127.0.0.1:3000`, plus `bus.host: 0.0.0.0` only if the proxy is on another host (DEPLOYMENT.md rules apply).
- ATS: HTTPS with a valid cert → no exceptions. For a LAN-only http POC, add `NSAppTransportSecurity/NSExceptionDomains` for the host and remove before MVP.
- `tailscale serve` path mounting keeps every other bus route unreachable from the phone.

---

## 10. Security and privacy

- Bearer token = send-as-contact credential; ≥ 16 chars random; rotate by editing config + app; stored in Keychain (`kSecAttrAccessibleAfterFirstUnlock`, no iCloud sync).
- Per-token rate limit (FR-8) — the endpoint is voice-triggered and cheap to hammer by accident (Siri retries).
- Logs: 60-char preview of text only (repo convention); full text lives in `transcripts` as today.
- Replies in notifications: app setting "Show reply on Lock Screen" (default on for single-user device); `UNNotificationContent.interruptionLevel = .timeSensitive` off by default.
- `debug_delay_ms` refuses to start with `NODE_ENV=production`.

---

## 11. Bus: observability

- `[siri] ask request_id=<uuid8> contact=contact:chris text="<60 chars>" `
- `[siri] queued request_id=… message_id=… queued_ms=14`
- `[siri] answered request_id=… answered_ms=8931 first=true`
- `[siri] timeout request_id=… waited_ms=20000` / `[siri] late-reply request_id=… fallback=bluebubbles`
- `GET /api/v1/siri/requests` is the latency dataset; `scripts/siri-probe.ts` computes p50/p95 from it.
- `/status` slash command output gains a `siri: pending N, answered_24h M, p50_24h Xs` line (E45, small).

---

## 12. iOS app: Peggy

### 12.1 Layout (`apps/ios/Peggy/`)

```
apps/ios/Peggy/
├── CLAUDE.md                     # agent rules for the iOS subtree (template in E44)
├── project.yml                   # XcodeGen → Peggy.xcodeproj (generated, git-ignored)
├── Peggy/
│   ├── App/PeggyApp.swift        # @main App; AppDelegate adaptor for background URLSession + notifications
│   ├── App/RootView.swift        # tabs: History, Settings
│   ├── Intents/AskPeggyIntent.swift
│   ├── Intents/PeggyShortcuts.swift
│   ├── Intents/AskPeggyLongIntent.swift        # E45 spike (LongRunningIntent)
│   ├── Networking/BusClient.swift              # actor; typed errors; protocol for mocking
│   ├── Networking/BusModels.swift              # Codable DTOs mirroring §4
│   ├── Networking/BackgroundReplyFetcher.swift # background URLSession + completion → notification
│   ├── Storage/Settings.swift                  # UserDefaults-backed
│   ├── Storage/Keychain.swift                  # small SecItem wrapper
│   ├── Storage/AskRecord.swift                 # SwiftData @Model
│   ├── Notifications/Notifier.swift            # UNUserNotificationCenter helpers
│   ├── Views/HistoryView.swift, SettingsView.swift
│   ├── Resources/Assets.xcassets, Info.plist (generated by XcodeGen from project.yml)
│   └── Phase3/ (E46/E47: Entities/, Intents/Messages/, Sync/)
└── PeggyTests/
    ├── AskPeggyIntentTests.swift              # AppIntentsTesting
    ├── BusClientTests.swift                   # URLProtocol stub
    └── Support/MockBusClient.swift
```

### 12.2 `project.yml` (XcodeGen)

```yaml
name: Peggy
options:
  bundleIdPrefix: com.chrispatten
  deploymentTarget: { iOS: "27.0" }
  xcodeVersion: "27.0"
  createIntermediateGroups: true
settings:
  base:
    SWIFT_VERSION: "6.0"
    SWIFT_STRICT_CONCURRENCY: complete
    DEVELOPMENT_TEAM: "${DEVELOPMENT_TEAM}"   # export DEVELOPMENT_TEAM=XXXXXXXXXX before xcodegen
    CODE_SIGN_STYLE: Automatic
targets:
  Peggy:
    type: application
    platform: iOS
    sources: [Peggy]
    info:
      path: Peggy/Info.plist
      properties:
        CFBundleDisplayName: Peggy
        UILaunchScreen: {}                     # required by the 27 SDK
        UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: false }
        NSUserNotificationsUsageDescription: Peggy notifies you when a slow answer arrives.
        UIBackgroundModes: [fetch]             # BGAppRefresh for Phase 3 sync; not needed for the intent itself
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: false }
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.chrispatten.peggy
        INFOPLIST_KEY_NSAppTransportSecurity: {}
        ENABLE_APP_INTENTS_METADATA: YES       # App Intents metadata extraction (Xcode does this automatically for app targets; explicit for clarity)
    entitlements:
      path: Peggy/Peggy.entitlements
      properties:
        aps-environment: development           # Phase 3 (E46) only; remove until then if it blocks signing
  PeggyTests:
    type: bundle.unit-test
    platform: iOS
    sources: [PeggyTests]
    dependencies: [{ target: Peggy }]
schemes:
  Peggy:
    build: { targets: { Peggy: all, PeggyTests: [test] } }
    test: { targets: [PeggyTests] }
```

Commands (documented in `apps/ios/Peggy/CLAUDE.md`):
```bash
brew install xcodegen
cd apps/ios/Peggy && xcodegen generate
xcodebuild -project Peggy.xcodeproj -scheme Peggy -destination 'generic/platform=iOS' build
xcodebuild -project Peggy.xcodeproj -scheme Peggy -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
# device install: open in Xcode once for signing, or: xcodebuild … -destination 'id=<udid>' -allowProvisioningUpdates install
```

### 12.3 Storage

```swift
// Storage/Settings.swift
import Foundation

struct Settings: Sendable {
    var baseURL: URL?              // https://mini.<tailnet>.ts.net
    var waitBudgetSeconds: Double  // 5...25, default 20
    var showReplyOnLockScreen: Bool

    static func load() -> Settings {
        let d = UserDefaults.standard
        return Settings(
            baseURL: d.string(forKey: "baseURL").flatMap(URL.init(string:)),
            waitBudgetSeconds: d.object(forKey: "waitBudget") as? Double ?? 20,
            showReplyOnLockScreen: d.object(forKey: "showReplyOnLockScreen") as? Bool ?? true)
    }
    func save() { /* symmetric */ }
}

// Storage/Keychain.swift — minimal, no dependency
enum Keychain {
    static let service = "com.chrispatten.peggy"
    enum Key: String { case siriToken, busToken }

    static func set(_ value: String, for key: Key) throws {
        let data = Data(value.utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: key.rawValue]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly // readable by a background intent after first unlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }
    static func get(_ key: Key) -> String? { /* SecItemCopyMatching with kSecReturnData */ nil }
    enum KeychainError: Error { case status(OSStatus) }
}

// Storage/AskRecord.swift
import SwiftData
@Model final class AskRecord {
    @Attribute(.unique) var requestID: String
    var question: String
    var reply: String?
    var extraReplies: [String]
    var status: String          // pending | answered | failed | unreachable
    var createdAt: Date
    var answeredAt: Date?
    var answeredMs: Int?
    init(requestID: String, question: String) { self.requestID = requestID; self.question = question; self.extraReplies = []; self.status = "pending"; self.createdAt = .now }
}
```

### 12.4 Networking

```swift
// Networking/BusModels.swift
struct AskRequest: Encodable { let text: String; let wait_ms: Int; let request_id: String; let client: ClientInfo }
struct ClientInfo: Encodable { let device: String; let app_version: String; let locale: String }
struct ReplyDTO: Decodable { let message_id: String?; let body: String; let received_at: String? }
struct TimingDTO: Decodable { let queued_ms: Int?; let answered_ms: Int?; let waited_ms: Int? }
struct AskResponse: Decodable { let ok: Bool; let request_id: String; let message_id: String?; let status: String; let reply: ReplyDTO?; let timing: TimingDTO?; let extra_replies: [String]? }
struct HealthResponse: Decodable { let ok: Bool; let routed: Bool; let agent: String?; let version: String? }

enum BusError: Error, Equatable {
    case notConfigured, unauthorized, rateLimited(retryAfterMs: Int?), duplicate, unreachable(String), badResponse(Int), decoding
}

enum AskOutcome: Equatable { case answered(String, extras: [String]); case pending(requestID: String) }

// Networking/BusClient.swift
protocol BusClientProtocol: Sendable {
    func ask(_ text: String, requestID: String, waitSeconds: Double) async throws -> AskOutcome
    func fetchReply(requestID: String, waitSeconds: Double) async throws -> AskOutcome
    func health() async throws -> HealthResponse
}

actor BusClient: BusClientProtocol {
    private let settings: Settings
    private let siriToken: String
    private let busToken: String?
    private let session: URLSession

    init(settings: Settings, siriToken: String, busToken: String?) {
        self.settings = settings; self.siriToken = siriToken; self.busToken = busToken
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = settings.waitBudgetSeconds + 3   // server cap + slack
        cfg.timeoutIntervalForResource = settings.waitBudgetSeconds + 5
        cfg.waitsForConnectivity = false                                  // fail fast if Tailscale is down
        session = URLSession(configuration: cfg)
    }

    func ask(_ text: String, requestID: String, waitSeconds: Double) async throws -> AskOutcome {
        var req = try makeRequest(path: "/api/v1/siri/ask", method: "POST")
        req.httpBody = try JSONEncoder().encode(AskRequest(
            text: text, wait_ms: Int(waitSeconds * 1000), request_id: requestID,
            client: .init(device: "iphone", app_version: Bundle.main.appVersion, locale: Locale.current.identifier)))
        return try await send(req)
    }

    func fetchReply(requestID: String, waitSeconds: Double) async throws -> AskOutcome {
        let req = try makeRequest(path: "/api/v1/siri/replies/\(requestID)?wait_ms=\(Int(waitSeconds * 1000))", method: "GET")
        return try await send(req)
    }

    func health() async throws -> HealthResponse {
        let (data, resp) = try await session.data(for: try makeRequest(path: "/api/v1/siri/health", method: "GET"))
        try Self.check(resp); return try JSONDecoder().decode(HealthResponse.self, from: data)
    }

    private func makeRequest(path: String, method: String) throws -> URLRequest {
        guard let base = settings.baseURL else { throw BusError.notConfigured }
        var r = URLRequest(url: base.appending(path: path)); r.httpMethod = method
        r.setValue("Bearer \(siriToken)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let busToken { r.setValue(busToken, forHTTPHeaderField: "X-Bus-Token") }
        return r
    }

    private func send(_ req: URLRequest) async throws -> AskOutcome {
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.data(for: req) }
        catch { throw BusError.unreachable(error.localizedDescription) }
        try Self.check(resp)
        guard let decoded = try? JSONDecoder().decode(AskResponse.self, from: data) else { throw BusError.decoding }
        switch decoded.status {
        case "answered", "claimed": return .answered(decoded.reply?.body ?? "", extras: decoded.extra_replies ?? [])
        default: return .pending(requestID: decoded.request_id)
        }
    }

    private static func check(_ resp: URLResponse) throws {
        guard let http = resp as? HTTPURLResponse else { throw BusError.badResponse(0) }
        switch http.statusCode {
        case 200...299: return
        case 401: throw BusError.unauthorized
        case 409: throw BusError.duplicate
        case 429: throw BusError.rateLimited(retryAfterMs: nil)
        default: throw BusError.badResponse(http.statusCode)
        }
    }
}
```

### 12.5 The intent

```swift
// Intents/AskPeggyIntent.swift
import AppIntents

struct AskPeggyIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Peggy"
    static let description = IntentDescription("Ask Peggy a question and hear her answer.")
    static let supportedModes: IntentModes = .background      // [verify in Xcode 27 SDK] iOS 26+: never foregrounds the app
    static let isDiscoverable = true

    @Parameter(title: "Question", requestValueDialog: "What would you like to ask Peggy?")
    var question: String

    static var parameterSummary: some ParameterSummary { Summary("Ask Peggy \(\.$question)") }

    // Injected for tests; production resolves from Settings + Keychain.
    static var makeClient: @Sendable () throws -> any BusClientProtocol = {
        let s = Settings.load()
        guard let token = Keychain.get(.siriToken), s.baseURL != nil else { throw BusError.notConfigured }
        return BusClient(settings: s, siriToken: token, busToken: Keychain.get(.busToken))
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw $question.needsValueError("What would you like to ask Peggy?") }
        let requestID = UUID().uuidString
        let settings = Settings.load()
        let record = await AskHistory.shared.begin(requestID: requestID, question: text)

        let client: any BusClientProtocol
        do { client = try Self.makeClient() }
        catch { return .result(dialog: "Open the Peggy app to set up the connection first.") }

        do {
            let started = Date()
            switch try await client.ask(text, requestID: requestID, waitSeconds: settings.waitBudgetSeconds) {
            case .answered(let body, let extras):
                await AskHistory.shared.answered(record, body: body, extras: extras, ms: Int(Date().timeIntervalSince(started) * 1000))
                return .result(dialog: IntentDialog(full: "\(body)", supporting: "\(body)"))
            case .pending:
                await BackgroundReplyFetcher.shared.schedule(requestID: requestID)   // §12.6
                return .result(dialog: "Peggy's still working on it — I'll notify you when she answers.")
            }
        } catch BusError.unauthorized {
            await AskHistory.shared.failed(record, reason: "unauthorized")
            return .result(dialog: "Peggy rejected the token. Open the Peggy app to fix the setup.")
        } catch BusError.duplicate {
            return .result(dialog: "I just asked Peggy that — give her a moment.")
        } catch BusError.rateLimited {
            return .result(dialog: "Peggy is getting too many requests right now. Try again in a minute.")
        } catch {
            await AskHistory.shared.failed(record, reason: "\(error)")
            return .result(dialog: "I can't reach Peggy right now. Check that Tailscale is connected.")
        }
    }
}

// Intents/PeggyShortcuts.swift
struct PeggyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskPeggyIntent(),
            phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) a question", "Talk to \(.applicationName)", "Hey \(.applicationName)"],
            shortTitle: "Ask Peggy",
            systemImageName: "bubble.left.and.text.bubble.right")
    }
    static let shortcutTileColor: ShortcutTileColor = .navy
}
```

Notes:
- `IntentDialog` interpolation escapes nothing; Peggy's reply is plain text by prompt contract. Strip residual markdown (`*`, `#`, backticks, URLs) client-side in `SpeechSanitizer.clean(_:)` before returning (tested).
- If Siri AI fills `question` from "Ask Peggy X" (E44 test), the `requestValueDialog` prompt is skipped automatically; nothing to change.
- `ShowsSnippetView` (a small SwiftUI card with the reply) is a Phase-3 polish item; voice-first for MVP.

### 12.6 Late-reply hand-off (background URLSession)

```swift
// Networking/BackgroundReplyFetcher.swift
final class BackgroundReplyFetcher: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = BackgroundReplyFetcher()
    static let sessionID = "com.chrispatten.peggy.late-reply"
    var completionHandler: (@Sendable () -> Void)?           // set by AppDelegate.handleEventsForBackgroundURLSession

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.background(withIdentifier: Self.sessionID)
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        cfg.timeoutIntervalForRequest = 120
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()

    func schedule(requestID: String) async {
        guard let s = Optional(Settings.load()), let base = s.baseURL, let token = Keychain.get(.siriToken) else { return }
        var req = URLRequest(url: base.appending(path: "/api/v1/siri/replies/\(requestID)?wait_ms=90000"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let bt = Keychain.get(.busToken) { req.setValue(bt, forHTTPHeaderField: "X-Bus-Token") }
        let task = session.downloadTask(with: req)
        task.taskDescription = requestID
        task.resume()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let requestID = downloadTask.taskDescription, let data = try? Data(contentsOf: location),
              let r = try? JSONDecoder().decode(AskResponse.self, from: data) else { return }
        if r.status == "answered" || r.status == "claimed", let body = r.reply?.body {
            Task { await AskHistory.shared.answeredLate(requestID: requestID, body: body, extras: r.extra_replies ?? []) }
            Notifier.post(title: "Peggy", body: body, threadID: requestID)
        } else {
            Task { await self.schedule(requestID: requestID) }   // still pending: re-arm (bounded: stop after 5 attempts / 10 min)
        }
    }
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { self.completionHandler?(); self.completionHandler = nil }
    }
}
```
`PeggyApp` uses `@UIApplicationDelegateAdaptor` to implement `application(_:handleEventsForBackgroundURLSession:completionHandler:)`, store the handler, and rebuild the session by identifier.

Alternative evaluated in E45: `AskPeggyLongIntent: LongRunningIntent` using `performBackgroundTask { … progress.localizedAdditionalDescription = "Peggy is thinking…" … }` to wait up to 120 s inside the intent (system Live Activity), posting the notification itself. Keep whichever measures better in `spike-results.md`.

### 12.7 Notifications

`Notifier.requestAuthorization()` during setup; `Notifier.post(title:body:threadID:)` builds `UNMutableNotificationContent` (`sound = .default`, `threadIdentifier = "peggy"`), immediate trigger. Phase 3 adds `content.appEntityIdentifiers = [EntityIdentifier(for: MessageEntity.self, identifier: id)]`.

### 12.8 Views

- `SettingsView`: base URL, Siri token (SecureField), bus token (optional), wait budget slider (5–25 s), "Test connection" → `health()` → "Connected · routed to agent:peggy · bus 0.12.0", notification permission button, "Hide reply on Lock Screen" toggle, "Try in Shortcuts" (`ShortcutsLink`) and `SiriTipView(intent: AskPeggyIntent())`.
- `HistoryView`: `@Query` list of `AskRecord`s newest first; status badge; tap pending → `fetchReply(wait 0)`; pull-to-refresh → `GET /requests` merge.

---

## 13. Phase 3: Peggy as a Siri AI source (E46, E47)

### 13.1 Messages domain model (E46)

```swift
@AppEntity(schema: .messages.messagePerson)
struct PeggyPersonEntity { /* id "peggy", name "Peggy", handle "peggy@agentbus" */ }

@AppEntity(schema: .messages.conversation)
struct ConversationEntity { /* id = bus conversation_id; participants: [PeggyPersonEntity]; name: channel label */ }

@AppEntity(schema: .messages.message)
struct MessageEntity: IndexedEntity {
    @Property(indexingKey: \.textContent) var body: AttributedString?      // per WWDC26-240
    // sender, recipients, conversation, sentDate, attachments filled from the bus transcript row
}

@AppIntent(schema: .messages.sendMessage)
struct SendMessageIntent {                      // Xcode will insist on draftMessage/editSentMessage/unsendMessage/setMessageReadStatus too
    func perform() async throws -> some ReturnsValue<MessageEntity> & ProvidesDialog {
        // 1. POST /api/v1/siri/ask with wait_ms = min(budget, 15000)  → speak the reply if it arrives, else "Sent to Peggy"
        // 2. persist the outbound MessageEntity, index it; reply (now or later) becomes a MessageEntity + notification w/ entity id
    }
}
```
- `draftMessage` opens the in-app compose view (`supportedModes = .foreground`).
- `editSentMessage` / `unsendMessage` → `throw PeggyIntentError.unsupported("Peggy messages can't be edited or unsent.")` — schema completeness only.
- `setMessageReadStatus` → local flag.
- Indexing: `CSSearchableIndex(name: "peggy-messages").indexAppEntities(entities)` after each sync; implement `IndexedEntityQuery` for reindex requests; delete on removal.
- Sync source: `GET /api/v1/sessions?contact_id=contact:chris&channel=siri` (+ opt-in other channels) → `GET /api/v1/sessions/:id/transcript` (E35). Incremental via `since`.
- Wake-ups: `BGAppRefreshTask` every ~15 min + fetch on foreground; **optional** APNs via a new `src/push/apns.ts` (token-based `.p8`, HTTP/2 `fetch` to `api.push.apple.com`; device token registered through `POST /api/v1/siri/devices`). Listed as a separate story so the epic ships without it.

### 13.2 Memory as a source (E47)

- Bus: `GET /api/v1/agents/:agent_id/memory` → `{ files: [{ path, sha256, updated_at, content }] }` reading `<working_dir>/<memory.dir>` for that cc-headless instance (reuse `assembleMemoryContext` file discovery; read-only; size cap 2 MB; bearer-authenticated via the siri token).
- App: `MemoryNoteEntity: IndexedEntity` (spike A: plain `IndexedEntity`; spike B: `.notes.note` schema if semantic Q&A requires a domain — the notes domain then requires its sibling schemas, which we implement as no-ops that throw). Index per file section (H2 headings) so hits are specific.
- Gate: five recall questions answered by Siri AI from notes. If only Messages-domain content gets semantic Q&A, keep memory indexing as Spotlight keyword search and stop.

---

## 14. Testing strategy

**Bus (vitest, `src/adapters/siri.test.ts`, `src/http/siri-routes.test.ts`):**
- auth: missing / malformed / unknown token → 401, no row, no enqueue; layered `X-Bus-Token`.
- happy path: POST /ask → row pending → stub adapter reply via `siri.send()` → 200 answered with timing.
- timeout: `wait_ms: 50` → pending; later `send()` → row answered; `GET /replies` returns it and marks claimed; fallback envelope enqueued to configured channel with rendered template; no fallback when not configured.
- dedup join: two identical asks in the window → same `request_id`, one enqueue; identical ask after the first completed but within window → 409.
- extra replies appended; unsolicited reply stored.
- rate limit 429; body-size 413; validation 400; no-route 503; health `routed:false`.
- restart: build a new adapter over the same DB → `GET /replies` still resolves.
- `debug_delay_ms` refuses under `NODE_ENV=production`.

**iOS (`PeggyTests`, AppIntentsTesting [verify API in Xcode 27] + XCTest):**
- `AskPeggyIntentTests`: for each `MockBusClient` scripted outcome (answered / pending / unauthorized / unreachable / duplicate / notConfigured) assert the dialog text and history status.
- `BusClientTests`: `URLProtocol` stub asserts headers, body, timeout mapping, status→error mapping.
- `SpeechSanitizerTests`: markdown stripped.

**End-to-end checklist (E44/E45, recorded in `spike-results.md`):** Shortcuts app run → Siri on device (screen unlocked, locked, AirPods, CarPlay) → Siri AI one-shot phrasing → cutoff measurement with `debug_delay_ms` at 10/15/20/25/30 s → late reply notification → fallback iMessage.

**Probe (`scripts/siri-probe.ts`, E42):** `--n 20 --mix trivial,memory,tool --wait 25000`; prints per-ask `queued_ms`/`answered_ms`, p50/p95, timeouts; writes CSV to `~/.agentbus/siri-probe-<date>.csv`.

---

## 15. Source tree changes

```
src/adapters/siri.ts                    (new)  SiriAdapter
src/adapters/siri.test.ts               (new)
src/http/siri-routes.ts                 (new)  registerSiriRoutes()
src/http/siri-routes.test.ts            (new)
src/http/api.ts                         (edit) register siri routes when enabled
src/config/schema.ts                    (edit) SiriAdapterSchema, contacts.siri.token, duplicate-token refine
src/db/migrations/013_siri_requests.sql (new)
src/index.ts                            (edit) instantiate/register SiriAdapter; pass to createHttpServer deps
src/core/delivery.ts                    (edit, E45) POLL_INTERVAL_MS → config bus.delivery_poll_ms
src/commands/handlers.ts                (edit, E45) /status siri line
scripts/siri-probe.ts                   (new, E42)
docs/SIRI_ADAPTER.md                    (new)
docs/HTTP_API.md, DEPLOYMENT.md, CC_HEADLESS_ADAPTER.md, CHANGELOG.md, config.yaml.example, .env.example (edit)
apps/ios/Peggy/**                        (new, E44+)
```

---

## 16. Architecture decision records

**ADR-1 — Synchronous long-poll over an async-only design.** Siri speaks only what `perform()` returns; there is no callback into a Siri session. Holding the request open (≤ 25 s) is the only way to get a spoken answer; the durable store makes the timeout path safe. Rejected: WebSocket/SSE (no benefit — one reply), APNs-only (no spoken answer).

**ADR-2 — Full adapter, not a bare route.** `DeliveryWorker` needs a `send()` target for channel `siri`; a registry entry also gives health visibility and E29 tool-status. Pebble's bare-route precedent applies only to receive-only channels.

**ADR-3 — Reuse Peggy's instance and routing; fast lane is a tuning option.** Adding a second agent identity duplicates memory-writing concerns (two journaling writers on the same files). Only data from Gate 0/1 justifies it; when used, the fast lane disables journaling and relies on transcripts.

**ADR-4 — Per-contact bearer token as identity (E25 pattern).** Keeps `contact-resolve` untouched, gives hard 401s, supports future multi-user without new config shapes.

**ADR-5 — Custom `AskPeggyIntent` first, Messages domain second.** The custom intent is ~150 lines and works with classic Siri and Siri AI today; the Messages domain needs five schemas, a conversation model, and sync — worth it for one-shot NL and for the semantic index, but not for the first spoken answer.

**ADR-6 — Monorepo `apps/ios/Peggy` with XcodeGen.** One repo for the agent, one `sprint-status.yaml`; generated `.xcodeproj` keeps diffs reviewable.

**ADR-7 — Fallback re-delivery is a templated outbound enqueue, not a relay.** `pipeline.relays` re-arrive a message as *inbound* (to an agent). A late Peggy reply must go *to Chris* on another channel: that is a plain `queue.enqueue` of an outbound envelope — deterministic, no LLM.

**ADR-8 — Tailscale `serve` path mount instead of widening `bus.host`.** Zero cert management, tailnet-only exposure, only `/api/v1/siri` visible.

---

## 17. Spikes and open questions (owners: E42/E44/E45/E47)

1. Measured `claude -p` cold-start for Peggy with and without `--resume`, with `journal_lookback_days` 3 vs 1. (E42)
2. Siri's real cutoff (`debug_delay_ms` sweep). (E44)
3. Siri AI one-shot parameter fill for a custom App Shortcut. (E44)
4. `LongRunningIntent` vs background `URLSession` for hand-off. (E45)
5. Semantic Q&A for non-schema `IndexedEntity` notes. (E47)
6. Exact Swift signatures for `IntentModes`, `IntentDialog(full:supporting:)`, `AppIntentsTesting` in the Xcode 27 SDK. (E44 — first story)
