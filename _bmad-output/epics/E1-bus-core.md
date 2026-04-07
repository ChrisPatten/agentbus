# E1 — Bus Core + SQLite Schema + Config Loader

| Field | Value |
|---|---|
| Epic ID | E1 |
| Build Order Position | 1 of 12 (first — no dependencies) |
| Dependencies | None |
| Story Count | 5 |
| Estimated Complexity | L |

---

## Epic Summary

E1 delivers the foundational infrastructure that every other epic depends on: a validated configuration system, a SQLite persistence layer with the full schema, a reliable message queue, and the adapter registry. Without E1, no adapter can connect, no message can be routed, and no data can be persisted. This epic is deliberately self-contained and produces no visible end-to-end behavior on its own — it exists purely to give the rest of the system something solid to stand on.

---

## Entry Criteria

- Repository initialized with TypeScript ESM project structure (`package.json`, `tsconfig.json`, `tsconfig.build.json`)
- Dependencies installed: `better-sqlite3`, `zod`, `js-yaml`, `dotenv`, `tsx`, `@types/*`
- `.env.example` and `config.yaml.example` committed as references
- Agreed schema design document (6 tables, FTS5 indices) available

---

## Exit Criteria

- `AppConfig` type is exported and all field validations pass against a valid `config.yaml`
- `${VAR}` substitution correctly resolves env references in config values
- SQLite database initializes cleanly on first run and is idempotent on subsequent runs (no errors, no duplicate table creation)
- All 6 tables exist with correct columns and indices after migration
- FTS5 virtual tables and associated triggers are created and operational
- `MessageQueue.enqueue()` / `dequeue()` / `ack()` round-trips work in unit tests
- `AdapterRegistry.register()` / `lookup()` work and are covered by tests
- Zero `any` types in E1 source files; all exported interfaces have JSDoc comments

---

## Stories

### S1.1 — Config Loader

**User story:** As a bus-core process, I want to load and validate `config.yaml` merged with `.env` variables so that all downstream components receive a fully-typed, trustworthy `AppConfig` at startup without manual environment juggling.

**Acceptance criteria:**
- `loadConfig(path: string): AppConfig` reads `config.yaml` via `js-yaml`, calls `dotenv.config()` before parsing
- All `${VAR_NAME}` tokens in string values are substituted with the corresponding `process.env` value; unresolved tokens throw a descriptive error
- Zod schema validates shape and types; a failed validation logs the full Zod error tree and throws (process exits non-zero)
- `AppConfig` includes typed sub-objects for `database`, `http`, `adapters[]`, `pipeline`, and `memory` sections
- Unit tests cover: valid config, missing required field, unresolved env ref, extra unknown fields (should be stripped, not error)

**Complexity:** S

---

### S1.2 — SQLite Client

**User story:** As bus-core, I want a SQLite client wrapper that opens the database in WAL mode and runs schema migrations on startup so that I have a durable, concurrent-safe store without manual database setup.

**Acceptance criteria:**
- `createDb(path: string): Database` opens (or creates) the SQLite file, immediately executes `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`
- `runMigrations(db: Database): void` is called once at startup and is fully idempotent (safe to call on an already-migrated DB)
- Migrations are versioned via a `_migrations` table storing `(version INTEGER, applied_at TEXT)`; each migration file checks `version` before applying
- The client wrapper is exported as a singleton per process (created once, shared)
- Integration test: delete DB file → start → verify all tables exist → start again → verify no error and no duplicate tables

**Complexity:** S

---

### S1.3 — Schema + Migrations

**User story:** As a bus-core developer, I want all 6 database tables created with correct columns, indices, and FTS5 virtual tables so that every feature has a reliable, queryable persistence structure from day one.

**Acceptance criteria:**
- Migration creates: `sessions`, `transcripts`, `session_summaries`, `memories`, `message_queue`, `dead_letter` with the agreed column definitions
- `transcripts` and `memories` each have a corresponding FTS5 virtual table (`transcripts_fts`, `memories_fts`) with `content=` pointing to the source table
- FTS5 `AFTER INSERT` and `AFTER DELETE` triggers on `transcripts` and `memories` keep the FTS index in sync automatically
- All foreign key relationships (e.g., `transcripts.session_id → sessions.id`) are declared with `ON DELETE CASCADE` where appropriate
- Schema migration SQL is stored in `/src/db/migrations/001_initial_schema.sql` (or equivalent) and checked into source control

**Complexity:** M

---

### S1.4 — MessageQueue Class

**User story:** As the inbound pipeline, I want a `MessageQueue` class with enqueue, dequeue, ack, and dead-letter operations so that messages are reliably delivered at least once and failures are captured for inspection.

**Acceptance criteria:**
- `enqueue(envelope: Envelope): string` inserts a row into `message_queue` with status `pending`, returns the generated `message_id`
- `dequeue(recipientId: string, channel?: string, limit?: number): QueuedMessage[]` selects `pending` rows ordered by `priority DESC, created_at ASC`, atomically marks them `processing` within a transaction
- `ack(messageId: string): void` marks the row `delivered` and records `delivered_at`
- `deadLetter(messageId: string, reason: string): void` moves the row to `dead_letter` with `reason` and current timestamp; removes from `message_queue`
- `sweepExpired(): number` marks messages past `expires_at` as dead-lettered with reason `expired`; returns count of swept messages
- Unit tests cover concurrent dequeue (no double-delivery), expiry sweep, and dead-letter promotion

**Complexity:** M

---

### S1.5 — AdapterRegistry

**User story:** As bus-core, I want an `AdapterRegistry` that tracks registered adapter instances by ID and declared channel so that the routing layer can look up the correct adapter for any outbound message without hardcoded conditionals.

**Acceptance criteria:**
- `register(adapter: AdapterInstance): void` stores the adapter keyed by `adapter.id`; throws if ID is already registered
- `lookup(adapterId: string): AdapterInstance | undefined` returns the adapter or `undefined`
- `lookupByChannel(channel: string): AdapterInstance[]` returns all adapters that declare the given channel in their `capabilities.channels[]`
- `list(): AdapterInstance[]` returns all registered adapters with their full capability objects
- `deregister(adapterId: string): void` removes an adapter (used during graceful shutdown)
- The registry is typed; `AdapterInstance` interface is defined here and re-exported for use by E11

**Complexity:** S

---

## Notes

- **WAL mode is non-negotiable.** Multiple processes (bus-core, adapters via HTTP) reading simultaneously makes WAL essential. Document this prominently.
- **Migration idempotency pattern:** Use `CREATE TABLE IF NOT EXISTS` + the `_migrations` version table. Don't use a library like `db-migrate` — keep it hand-rolled to minimize dependencies and maintain full visibility.
- **FTS5 triggers vs. external content:** The `content=` FTS5 table approach means FTS stays in sync automatically via triggers, but a `REBUILD` command must be available for recovery. Add a CLI flag `--rebuild-fts` that triggers this.
- **`Envelope` type:** Define the canonical `Envelope` interface in E1 (`/src/types/envelope.ts`) since MessageQueue and AdapterRegistry both reference it. This is the single source of truth — all epics import from here.
- **Zod + js-yaml parsing order:** Parse YAML first, then walk the object tree substituting `${VAR}` strings, then run Zod. This ensures Zod sees final values.
- **`better-sqlite3` is synchronous** — this is intentional and a feature. All DB calls are sync and can be wrapped in transactions without `await` complexity.
