# E5 — Inbound Pipeline

| Field | Value |
|---|---|
| Epic ID | E5 |
| Build Order Position | 4 of 12 |
| Dependencies | E1 (AppConfig, SQLite, MessageQueue, AdapterRegistry) |
| Story Count | 4 |
| Estimated Complexity | M |

---

## Epic Summary

E5 builds the 8-stage middleware chain that every inbound message passes through before being enqueued for delivery. The pipeline normalizes raw adapter payloads into canonical `Envelope` objects, enriches them with contact metadata, deduplicates repeated messages, classifies topics, scores priority, resolves routing targets, and writes transcripts. After E5, the bus has a structured, extensible processing backbone that all adapter messages flow through.

---

## Entry Criteria

- E1 complete: `Envelope` type defined, `MessageQueue.enqueue()` available, SQLite `transcripts` and `sessions` tables exist
- `AdapterRegistry` available for route-resolve stage lookups
- `AppConfig` includes pipeline configuration section (stage enable/disable flags, priority weights, dedup window)
- Architecture decision on pipeline stage numbering / priority slots is finalized (10, 20, 30, … 80)

---

## Exit Criteria

- `PipelineEngine.process(rawPayload, adapterContext)` successfully runs all 8 stages in order
- Any stage returning `null` aborts the pipeline; the message is dropped and the drop is logged with reason
- All 8 stage functions exist as separate, independently testable modules
- Deduplication prevents the same message content from the same sender within the configured window (default 30s)
- Fan-out stage produces N `Envelope` objects when `also_notify` targets are configured; each is independently enqueued
- End-to-end integration test: simulate raw Telegram payload → run through pipeline → verify enqueued message and transcript row

---

## Stories

### S5.1 — PipelineEngine

**User story:** As bus-core, I want a `PipelineEngine` that runs middleware stages in priority order so that I can add, remove, or reorder processing steps without changing the core routing logic.

**Acceptance criteria:**
- `PipelineEngine` class exposes `use(stage: PipelineStage, priority: number): void` for registration and `process(context: PipelineContext): Promise<PipelineContext | null>` for execution
- Stages are sorted by priority ascending before execution; lower number = earlier in chain (stage 10 runs before stage 80)
- If any stage returns `null` or `undefined`, `process()` returns `null` immediately without calling remaining stages
- `PipelineContext` is a mutable object passed by reference through all stages; each stage can read and write properties on it
- Stage errors (thrown exceptions) are caught by the engine, logged with stage name and error details, and treated as a `null` return (pipeline abort) unless the stage is marked `critical: false`, in which case the error is logged and the pipeline continues
- Unit tests: 3-stage chain → all pass; middle stage returns null → verify third stage not called; stage throws → verify abort

**Complexity:** M

---

### S5.2 — Stages 1–4: Normalize, Contact-Resolve, Dedup, Slash-Command Detect

**User story:** As the pipeline, I want the first four stages to transform raw adapter payloads into clean, enriched, deduplicated envelopes with slash commands flagged so that all downstream stages work with consistent, trustworthy data.

**Acceptance criteria:**
- **Stage 10 — Normalize:** Maps raw adapter payload (Telegram update, BlueBubbles webhook, etc.) to canonical `Envelope` shape; sets `received_at`, `source_adapter_id`, `raw_payload` (stringified); throws if required fields are missing
- **Stage 20 — Contact-Resolve:** Looks up `sender_id` in a contacts table or config-defined contact map; enriches `context.contact` with `{ display_name, preferred_channel, tags[], metadata }`; allows unknown senders through (sets `contact: null`) unless adapter is configured `allowlist_only`
- **Stage 30 — Dedup:** Computes `dedup_key = sha256(sender_id + body + floor(received_at / window_ms))`; queries `transcripts` for a matching key within the window; if found, returns `null` (drop) and increments a dedup counter metric
- **Stage 40 — Slash-Command Detect:** If `body` starts with `/`, extracts command name and args into `context.slashCommand = { name, args[] }`; sets `context.isSlashCommand = true`; does not abort (slash commands continue through remaining stages for transcript logging)
- Each stage is a pure function exported from its own file; no stage imports another stage

**Complexity:** M

---

### S5.3 — Stages 5–8: Topic-Classify, Priority-Score, Route-Resolve, Transcript-Log

**User story:** As the pipeline, I want the final four stages to classify message topics, score delivery priority, determine recipients, and persist the message to the transcript so that routing is intelligent and every processed message is durably recorded.

**Acceptance criteria:**
- **Stage 50 — Topic-Classify:** Applies keyword/regex rules from `AppConfig.pipeline.topicRules[]` to set `context.topics[]` (e.g., `["urgent", "financial", "personal"]`); rules are evaluated in order; first match wins per topic slot; no-match sets `topics: []`
- **Stage 60 — Priority-Score:** Computes `context.priority` (integer 0–100) using configurable weights: base score + topic bonuses + sender tier bonus + time-of-day modifier; `urgent` topic adds +40, VIP sender tier adds +20 (weights in `AppConfig`)
- **Stage 70 — Route-Resolve:** Looks up `context.envelope.recipient_id` against routing rules in `AppConfig.pipeline.routes[]`; resolves to a list of `{ adapterId, recipientId }` tuples; sets `context.routes[]`; if no rule matches, defaults to `peggy` on `claude-code` channel
- **Stage 80 — Transcript-Log:** Inserts the finalized `Envelope` into the `transcripts` table with all enriched fields; returns the updated context (does not abort); logs at `debug` level on success
- Unit tests for each stage independently; integration test verifies all four run in sequence with correct field propagation

**Complexity:** M

---

### S5.4 — Fan-Out: Multi-Target Routing

**User story:** As the pipeline, I want the route-resolve stage to support fan-out to multiple `also_notify` targets so that a single inbound message can trigger delivery to both the primary recipient and additional interested parties without duplicating pipeline processing.

**Acceptance criteria:**
- `AppConfig.pipeline.routes[]` supports an optional `also_notify: [{ adapterId, recipientId }]` array alongside the primary route
- After Stage 70 completes, if `also_notify` targets exist, `context.routes[]` contains the primary target plus all `also_notify` targets
- `PipelineEngine.process()` returns a single `PipelineContext` with a populated `routes[]`; the caller (bus HTTP handler) is responsible for calling `MessageQueue.enqueue()` once per route entry
- Each enqueued message gets a unique `message_id` but shares the same `conversation_id` and `dedup_key`
- If any individual enqueue fails, the others are not rolled back; each failure is logged independently
- Integration test: configure `also_notify` with 2 extra targets → process message → verify 3 queue rows with distinct `message_id`s

**Complexity:** S

---

## Notes

- **Pipeline stages are pure functions, not classes.** Define each stage as `type PipelineStage = (ctx: PipelineContext) => Promise<PipelineContext | null>`. This keeps them easily testable in isolation.
- **`PipelineContext` shape:** Think carefully about what goes on context vs. what stays on `Envelope`. The rule of thumb: `Envelope` is the external-facing message format; `PipelineContext` is the internal working object that wraps `Envelope` and carries enrichment data (`contact`, `topics`, `routes`, `slashCommand`, `dedup_key`, etc.).
- **Dedup window configuration:** Default to 30 seconds, configurable per adapter. The dedup key uses a time bucket (floor division by window_ms), so messages at the boundary of two windows may slip through. This is acceptable for the use case.
- **Stage 40 (slash-command detect) does NOT route differently.** It only flags the command. The actual command execution happens in E6. The pipeline still logs the slash command as a transcript entry — this is intentional for audit purposes.
- **Route-resolve fallback:** Defaulting to `peggy@claude-code` when no rule matches means unrouted messages always reach Peggy. This is the right behavior for a personal assistant bus. Add a config flag `pipeline.dropUnrouted: true` for cases where this isn't desired.
- **Fan-out and transcript:** Only one transcript entry is created per message (Stage 80 runs once). The fan-out only multiplies queue entries. If you need per-recipient transcript rows, that's a future requirement.
- **Performance:** All 8 stages are synchronous-compatible (SQLite is sync). Consider making `PipelineEngine.process()` sync rather than async to avoid unnecessary Promise overhead, unless Stage 50 ever calls an external classification API.
