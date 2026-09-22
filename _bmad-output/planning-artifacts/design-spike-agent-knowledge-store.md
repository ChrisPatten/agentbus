# AgentBus — Design Spike: Agent-Managed Knowledge Store

**Status:** Phase 1 implemented (E50, `content_hash` added per below) + the
context-block ledger implemented as a standalone epic (E49, §9.1). Phases
0/2–4 remain PROPOSED — awaiting decision. See §12 for what's still open.
**Author:** drafted 2026-09-20
**Supersedes/extends:** E8/E9 structured memory (dormant), E20 file-memory model, E30 decoupled journaling
**Related:** E47 (memory export for Siri indexing), `docs/MEMORY_MODEL.md`, `_bmad-output/planning-artifacts/principles.md`

---

## 1. The problem

The E20 file-memory model made the agent's own files the source of truth. That
was the right call and it is not in dispute here. But it has two costs that
compound as the corpus grows:

**Retrieval is grep.** `MEMORY.md` is a hand-curated index; everything else —
400+ daily journals, topic files — is only findable by the agent reading or
grepping it. Grep needs the agent to already know the word that was used. "What
did we decide about the Mansfield property taxes?" only works if the note says
"Mansfield" and not "the rental."

**Injection is blind.** `assembleMemoryContext()` front-loads `MEMORY.md` plus
the last `journal_lookback_days` daily files into *every* turn, regardless of
what the turn is about. At the default of 3 days that is roughly 4–8k tokens per
turn of mostly-irrelevant text, and it scales with how chatty the last three days
were, not with how relevant they are. Anything older than the lookback window is
invisible unless the agent goes looking.

**There is no metadata.** A fact learned in a file has no expiry, no
"relevant until", no importance, no structure. A note about a flight next Tuesday
and a note about someone's coffee order are the same kind of object forever.

The ask: a knowledge store the agent fully manages, that indexes what the agent
writes, and that answers a *question* rather than a *string match*.

---

## 2. Design in one paragraph

A single SQLite-backed knowledge store. The agent writes records with an
arbitrary JSON payload of its own design, an optional agent-authored **index
note** (prose describing what this is and when it should be recalled), and
optional metadata — tags, facets, importance, and four distinct dates. The bus
indexes each record three ways: a vector embedding of the payload, a *separate*
vector embedding of the index note, and an FTS5 keyword index. Retrieval fuses
all three legs plus structured facet/date filters into one ranked result. The
bus never authors content and never infers metadata — it stores, indexes, and
ranks what the agent gives it.

---

## 3. Why the index note is the important idea

This is the part worth building even if nothing else here ships.

Naive RAG fails on an asymmetry: notes are written in *statement* form, queries
arrive in *question* form, and the embedding of "Chris prefers the Mansfield
tenant contacted by text, not email" is not especially close to the embedding of
"how should I reach the tenant?" People paper over this with HyDE — generate a
hypothetical answer at query time, embed that. That costs an LLM call per query
and is a guess.

An agent-authored index note inverts it. At write time, when the agent has full
context, it writes the retrieval cue in the shape of the future question:

```
index_note: "How to contact the Mansfield tenant; which channel Chris wants used
             for tenant comms; what to do if the tenant doesn't respond."
```

Embed that separately from the payload and you get query-shaped text matching
query-shaped input, with zero query-time cost. Score a record as
`max(sim(q, vec_index), sim(q, vec_payload))` so the index note helps and never
hurts — a record whose literal content matches still wins on the payload leg.

The agent is already doing the reasoning that makes this note good. It just has
nowhere to put it today.

---

## 4. Schema

### 4.1 `knowledge`

```sql
CREATE TABLE knowledge (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,         -- multi-agent ready from day one
  kind            TEXT NOT NULL,         -- agent-declared: 'fact'|'decision'|'person'|'project'|...
  title           TEXT NOT NULL,         -- short human label
  payload         TEXT NOT NULL,         -- arbitrary JSON — the agent's own schema
  index_note      TEXT,                  -- optional retrieval cue (§3)
  body_text       TEXT NOT NULL,         -- derived: flattened payload text, for FTS + embedding
  tags            TEXT NOT NULL DEFAULT '[]',  -- JSON array, agent-supplied
  facets          TEXT NOT NULL DEFAULT '{}',  -- JSON object of scalars, agent-supplied
  content_hash    TEXT NOT NULL,         -- sha256(body_text), computed at write time (added in
                                          -- implementation, missing from this draft originally —
                                          -- see the injection-ledger note below)

  -- temporal (§6)
  event_at        TEXT,                  -- when the thing this is ABOUT happened/happens
  valid_from      TEXT,                  -- start of relevance interval
  relevant_until  TEXT,                  -- soft: past this, downweight but still findable
  expires_at      TEXT,                  -- hard: excluded from recall, swept after grace

  -- ranking signals
  importance      REAL NOT NULL DEFAULT 0.5,   -- 0..1, agent-assigned
  confidence      REAL NOT NULL DEFAULT 0.9,

  -- provenance
  source          TEXT NOT NULL,         -- 'agent'|'journal-sweep'|'file-ingest'|'import'
  session_id      TEXT, contact_id TEXT, channel TEXT,
  origin_path     TEXT,                  -- for file-ingest: source file + heading anchor

  -- lifecycle
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  superseded_by   TEXT,                  -- NULL = active
  last_recalled_at TEXT,
  recall_count    INTEGER NOT NULL DEFAULT 0
);
```

`payload` being opaque JSON is the "arbitrary schema" requirement: the bus
validates that it parses and nothing more. `body_text` is a mechanical flatten of
the payload's string leaves, used for FTS and embedding, so the agent never has
to duplicate content into a "searchable text" field.

**`content_hash` is computed and stored at write time, not left for a reader
to compute.** This was caught late in review: without it, a per-turn injection
path (§9.1) would have to re-hash a record's `body_text` on every candidate
check, every turn — wasted work on content that mostly doesn't change turn to
turn. Storing the hash on the row makes the dedup check a plain column
compare. Implemented in E50 (Phase 1) ahead of the injection path itself
(E49, §9.1) needing it — the column exists and is populated now; nothing
reads it for dedup yet, since no auto-injection path calls into the knowledge
store today.

### 4.2 Indexes

- **FTS5** virtual table over `title`, `index_note`, `body_text`, `tags` —
  external-content, trigger-synced, exactly the pattern migration 003 already
  uses for `memories_fts`.
- **`knowledge_vec`** (`sqlite-vec` `vec0` virtual table): two rows per record,
  discriminated by `slot IN ('payload','index')`, each carrying
  `embedding_model` and `dim`. Never mix vector spaces in one query.
- **B-tree** on `(agent_id, kind)`, `(agent_id, event_at)`,
  `(agent_id, relevant_until)`, `expires_at`.

### 4.3 `knowledge_facets` — the anti-drift catalog

```sql
CREATE TABLE knowledge_facets (
  agent_id TEXT, facet_key TEXT, facet_value TEXT,
  record_count INTEGER, last_used_at TEXT,
  PRIMARY KEY (agent_id, facet_key, facet_value)
);
```

Maintained by trigger on write. Agent-supplied facets have one predictable
failure mode — vocabulary drift (`project:mansfield` one week,
`property:mansfield-house` the next, and now neither filter finds everything).
A `list_facets` call lets the agent look up its own existing vocabulary before
writing, which fixes drift without the bus inferring anything.

### 4.4 `knowledge_edges` (phase 4)

`(from_id, to_id, rel)` — `supersedes`, `about`, `contradicts`, `part_of`.
Cheap to add, turns `get_knowledge` into a small graph walk. Deferred.

---

## 5. Retrieval: hybrid fusion

Three retrievers, one pre-filter, deterministic fusion.

**Pre-filter (SQL `WHERE`)** — `kind`, `tags` containment, `facets` JSON
equality, date-interval intersection, `superseded_by IS NULL`,
`expires_at > now`. This is a *filter*, never a scorer; it defines the candidate
set.

**Leg A — vector.** `sqlite-vec` KNN over both slots, take `max` per record.
**Leg B — keyword.** FTS5 `bm25()` over the same candidate set.
**Leg C — facet/recency.** Rank by `updated_at` within the filtered set, so a
pure "what's recent about X" query still returns something when A and B are weak.

**Fusion — Reciprocal Rank Fusion**, `score = Σ wᵢ / (60 + rankᵢ)`. RRF is used
rather than weighted score blending because BM25 scores and cosine similarities
are not on comparable scales and any normalization constant you pick is a lie
that drifts with corpus size. RRF only needs ranks.

**Post-fusion modifiers**, all config-weighted, all deterministic:

| Modifier | Effect |
|---|---|
| `importance` | multiplicative boost, agent-assigned |
| `relevant_until` in the past | decay factor (default 0.5), not exclusion |
| `updated_at` recency | mild half-life boost |
| `confidence` | multiplicative |

**Degradation is the point.** If the embedding provider is unconfigured, down, or
rate-limited, Leg A contributes nothing and the query still returns BM25 +
facet results. There is no state in which memory search hard-fails.

---

## 6. Time: four dates, and intervals not points

The date tool is worth more than "filter by created_at" because records carry
four genuinely different timestamps:

| Field | Answers |
|---|---|
| `created_at` | "what did I learn last Tuesday?" |
| `event_at` | "what happened on the June trip?" — written today, *about* June |
| `relevant_until` | "what's about to go stale?" |
| `expires_at` | hard TTL, sweep |

Treating each record as an interval `[valid_from, relevant_until]` and querying
by **intersection** rather than point-match is the clean primitive. "What was
active during the week of Sept 8" then correctly returns the lease that started
in March and runs through next year — which a `created_at BETWEEN` query would
miss entirely.

`recall_timeline(from, to, date_field, kind?, tags?)` exposes this directly, plus
two canned modes: `expiring_soon` and `stale` (no recall in N days, low
importance) — the latter being the hook for the agent to periodically prune its
own store. Nothing in the file model has any equivalent, which is why file memory
only ever grows.

---

## 7. Tool surface

Four core, two optional. Tool definitions cost context on *every* turn
(~250–400 tokens each), so this is deliberately not eight tools.

| Tool | Purpose |
|---|---|
| `write_knowledge` | Upsert. `kind`, `title`, `payload`, `index_note`, `tags[]`, `facets{}`, `event_at`, `valid_from`, `relevant_until`, `expires_at`, `importance`, `confidence`, `supersedes` |
| `search_knowledge` | Hybrid query + all filters. `explain: true` returns per-leg ranks for debugging |
| `get_knowledge` | By id(s); returns supersession chain and (phase 4) edges |
| `forget_knowledge` | Supersede, expire, or hard-delete |
| `recall_timeline` *(opt)* | §6 interval queries and the `expiring_soon` / `stale` modes |
| `list_facets` *(opt)* | §4.3 vocabulary discovery |

`recall_timeline` is formally expressible as `search_knowledge` with date args
and no query string, and could be collapsed. Keeping it separate is a bet that a
distinct verb gets used correctly more often than an overloaded one — worth
revisiting after real usage.

**Nothing writes to this store except the agent.** The journaling sweep (E30)
needs only a prompt change — "…and record durable structured facts with
`write_knowledge`" — no new machinery.

---

## 8. Embeddings

Pluggable `EmbeddingProvider`, four built-ins, model + dim stored per vector row.

| Provider | Model | Dims | Cost | Notes |
|---|---|---|---|---|
| `voyage` | `voyage-3.5-lite` | 1024 (256/512/2048 via Matryoshka) | **$0.02/M tokens**, first 200M free | Anthropic's recommended embedding partner; 32k context |
| `openai` | `text-embedding-3-small` | 1536 (truncatable) | **$0.02/M tokens** | Ubiquitous, well-understood |
| `ollama` | `nomic-embed-text` | 768 | **$0**, local | 8192-token native context (raise `num_ctx`; defaults to 2048 when served). Zero egress |
| `none` | — | — | — | FTS + facets + timeline only. Fully supported, not a degraded mode |

**Cost is a rounding error.** A personal memory corpus of ~5 MB of markdown is
roughly 1.25M tokens — about **$0.025 to index the entire thing**, once. Queries
run ~20 tokens. Voyage's 200M free tier covers years of this workload before a
bill exists. Cost is not a reason to choose a provider here; **privacy is** (§10).

**Operational trap, called out deliberately:** changing embedding model silently
poisons the index — new vectors live in a different space and cosine similarity
against old ones is meaningless noise, with no error. Mitigation: `model` and
`dim` are stored per vector row; a query refuses to run across mixed spaces and
a `reindex` job re-embeds under the new model.

**Sizing.** [`sqlite-vec`](https://github.com/asg017/sqlite-vec) is brute-force
KNN — no ANN index, no recall loss, and fine at personal scale. At 1024 dims
float32: 20k records ≈ 80 MB and a scan in the tens of milliseconds. If the
corpus reaches six figures, `int8` quantization (supported natively) cuts that
4× and Matryoshka truncation to 512 dims cuts it again.

---

## 9. Relationship to E20 files — the actual decision

Three options; the recommendation is C.

| | Model | Gives up |
|---|---|---|
| **A** | DB replaces files | Human-readable, greppable, git-versionable, hand-editable memory. Also throws away E20's best property: files auto-load because every channel runs in the same `working_dir` |
| **B** | Files stay sole source of truth; DB is a derived index only | The agent can never attach `expires_at` / `importance` / facets to a fact without inventing markdown frontmatter |
| **C** | **Both first-class, with a clean ownership split** | Two stores to keep coherent |

**Recommended split:**

- **`MEMORY.md` stays exactly as it is** — small, hand-curated, always front-loaded. It is the agent's front page, not a database, and it should never become one.
- **The daily journal stays** — it is a *log*: append-only, narrative, occasionally re-read. Logs don't want to be databases either.
- **The knowledge store takes the long tail** — every structured fact the agent wants to recall on demand, plus a one-way ingest of topic files and journals older than the lookback window (`source='file-ingest'`, chunked by H2, hash-based change detection, `origin_path` preserved).

Ingest is **strictly one-way**: files → index, never index → files. There is no
write-back path, so there is no drift to reconcile — the index is always
reconstructible by re-ingesting, and the files remain the thing a human reads.

### 9.1 The payoff: semantic memory injection — corrected, and partially built

This is the change that makes the whole proposal worth building. The version
below corrects two things the original draft got wrong.

**Correction 1 — the injection point.** The original draft said retrieved
records would ride in the **system prompt**. Wrong: the system prompt is the
first segment of the prompt-cache prefix (`tools` → `system` → `messages`),
and `cc-headless` re-rendered it on *every* turn — so anything volatile placed
there (retrieved records, which differ turn to turn by construction) would
bust the cache on every single turn, not save tokens. Retrieved content has to
ride in the **user turn** instead, where it accumulates in the resumed
session's own transcript and only needs to be sent once.

**Correction 2 — what actually needed building first.** Getting the
injection point right required a general per-session ledger — hash each
context block, send it once, resend only on change, clear on detected
compaction — because retrieved knowledge records aren't the only thing that
was being resent redundantly: `cc-headless`'s `{{memories}}` interpolation
(`MEMORY.md` + recent daily journals) had exactly the same bug, and fixing
that alone was worth more than this section originally gave it credit for.
**That ledger is now built, as its own epic (E49, not gated on anything in
this document) — `context_blocks` (migration 017),
`src/adapters/context-ledger.ts`.** It currently only ledgers memory-file
blocks. `search_knowledge` results are not yet wired into any per-turn
injection path — no such path exists today, in either `cc-headless` or
`cc-pool` — so this remains the design for future work, not something E49
already does. When it's built, it plugs into the same ledger (`block_key:
'knowledge:<id>'`), reading `knowledge.content_hash` (§4.1, also now built)
directly rather than re-hashing records on every check.

With that ledger in place, the original comparison still holds, updated for
where retrieval fits:

Today Stage 85 (`memory-inject`) front-loads the last 3 days of journal
regardless of topic — that's a *separate*, earlier mechanism (fires once per
new session, before `cc-headless` ever runs) and is unaffected by any of this.
The opportunity is downstream of it: **the inbound message is already a
query**, so a future per-turn call into `search_knowledge` could retrieve the
top-k relevant records into the user turn — ledgered, so only new or changed
records cost tokens on later turns:

| | Today (files only, pre-E49) | With E49 (built) | With E49 + knowledge retrieval (not built) |
|---|---|---|---|
| Injected per turn | `MEMORY.md` + last 3 dailies, ~4–8k tokens, **every turn** | Same files, but **once per session** unless changed | + top-k records, ledgered the same way |
| Relevance | temporal proximity only | temporal proximity only | semantic + keyword + recency |
| Reach | last 3 days | last 3 days | entire corpus |

E49 alone already captures most of the token saving described here — it just
does it for files, not yet for retrieved knowledge records. The remaining
piece (wiring `search_knowledge` into a per-turn call, for both
`cc-headless` and `cc-pool`, the latter having no per-turn injection point of
any kind today) is still open — see §12.

---

## 10. Risks and objections

**1. Principle #2 — "the bus core never calls an LLM."** Real tension, and the
strongest objection. The defense: embedding is *mechanical indexing*, the same
class of operation as FTS5 tokenization — it produces no content, makes no
judgment, and is deterministic given a pinned model. The bus still never authors
anything; the agent writes every byte of every record. It is also config-gated,
and the `none` provider is a fully supported configuration. This belongs in the
"capability extension" class alongside script-backed MCP tools, not in core
routing — and the design doc should say so rather than pretend there is no
tension.

**2. Privacy — likely the real deciding factor.** Every memory written would be
sent to a third-party embedding API. For a personal assistant whose memory
contains health, financial, and family content, that is a meaningfully different
posture than today, where memory never leaves the box. The `ollama` provider
gives full semantic search with **zero egress** at some quality cost, and
`none` keeps the store entirely local with FTS + facets + timeline. Worth
deciding this one up front rather than defaulting into it.

**3. Garbage in, garbage out.** "Fully agent-managed" means retrieval quality is
exactly as good as the index notes the agent writes. Mitigated by prompt guidance
in the journaling prompt, agent-side `CLAUDE.md` conventions, and `list_facets` —
but it is a genuine dependency on agent discipline, and it will be uneven at
first.

**4. Hybrid may not beat FTS5 here.** On a small corpus of well-written first-party
prose, BM25 is a stronger baseline than the RAG literature suggests. This is the
whole reason for the Phase 0 gate (§11) — if FTS5 alone wins on real questions
over the real corpus, ship facets and timeline and skip the vector leg entirely.

**5. Context cost of the tools themselves.** Six tool definitions on every turn is
~2k tokens, partially offsetting the §9.1 injection savings. Net is still
strongly positive, but it is not free and shouldn't be presented as free.

**6. `sqlite-vec` maturity.** v0.1.9, pre-1.0, last published ~5 months ago; its
predecessor `sqlite-vss` was abandoned in its favor. Pure C, no dependencies,
~1k dependent projects. Contained risk: the vector leg is one of three, and the
fallback to FTS + facets is already a supported configuration. Verified no
blocker on our side — `createDatabase()` uses `better-sqlite3` directly and
`SafeDatabase` only wraps the plugin slash-command path, so extension loading is
available.

---

## 11. Phasing

| Phase | Scope | Size | Gate | Status |
|---|---|---|---|---|
| **0** | **Spike.** Load `sqlite-vec` under `better-sqlite3`; index ~500 real journal sections; run 20 real questions; measure recall@5 for FTS5 alone vs. hybrid vs. hybrid+index-note | S | **Does hybrid actually beat FTS5 on this corpus?** If not, drop the vector leg and ship 1 only | Not run |
| **1** | Schema + migration, `write`/`get`/`forget`, FTS5 leg, `content_hash` at write time | M | Ships standalone value with zero embedding dependency | **Built (E50)** — `recall_timeline` and the `knowledge_facets` catalog/`list_facets` trimmed out as a fast-follow (facet *filtering* and the `facets` column shipped; the vocabulary-catalog convenience tool didn't) |
| **1.5** | Context-block ledger (didn't exist as a phase in the original draft — needed regardless of Phase 0's outcome, since it also fixes memory-file resending, not just knowledge records) | S | None — no embedding dependency | **Built (E49)** — files only; not yet consumed by knowledge-record retrieval, since Phase 3 doesn't exist yet |
| **2** | `EmbeddingProvider` + the three providers, vector leg, RRF fusion, `reindex` job | M | Phase 0 | Not started |
| **3** | Semantic injection (§9.1) wired into `cc-headless` via E49's ledger, + `cc-pool` (no per-turn injection point exists there today — new work, not just reuse) + one-way file ingest | S–M | Phase 1 (have) + Phase 2 or a keyword-only fallback | Not started |
| **4** | `knowledge_edges`, stale-review surface, `explain` mode | S | | Not started |

Phase 1 shipped standalone, as predicted: structured metadata, facets
filtering, and interval date queries work over FTS5 with no embeddings
anywhere. Phase 1.5 (the ledger) turned out to be independently valuable
enough to build before Phase 0's spike even ran — it fixes a real,
already-existing cost (`cc-headless` re-sending memory files every turn) that
has nothing to do with whether the knowledge store's hybrid search ever
proves out.

---

## 12. Open questions for decision

1. **Embedding provider** — cloud (`voyage-3.5-lite`, best quality, memory leaves the box) vs. local (`ollama`/`nomic-embed-text`, zero egress, lower quality) vs. start at `none` and add vectors after Phase 0 proves the case?
2. **§9 split** — accept C (files and store coexist with a one-way ingest), or keep the store purely additive and leave files untouched (skip Phase 3's ingest half)?
3. **Semantic memory-inject (§9.1)** — replace Stage 85's blind lookback, or run alongside it behind a config flag until it's proven?
4. **Tool count** — six as specced, or collapse `recall_timeline` and `list_facets` into `search_knowledge` to save ~700 tokens per turn?
5. **Dormant `memories` table** — migrate the E8 rows into `knowledge` as `kind='legacy-memory'`, or leave it dormant and untouched?
6. **Phase 0 first**, or commit straight to Phase 1 (which carries no embedding risk anyway)?
