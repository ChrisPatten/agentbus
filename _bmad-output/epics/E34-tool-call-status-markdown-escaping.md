# E34 — Tool-Call Status Stream: Escape Underscored Values Before Sending to Telegram

| Field | Value |
|---|---|
| Epic ID | E34 |
| Dependencies | None. Touches `src/adapters/tool-call-summary.ts` (E29) only; no interaction with E27/E28 topic routing. |
| Story Count | 2 |
| Estimated Complexity | S |

---

## Epic Summary

1. `formatToolCallSummary()` (`src/adapters/tool-call-summary.ts:46`)
   interpolates raw, dynamic tool-input values directly into a status line
   with no escaping: `file_path` (Read/Edit/Write), Bash/Agent `description`,
   Grep `pattern`, WebFetch `url`, WebSearch `query`, and the tool `name`
   itself in the generic fallback (`genericFallback()`, line 20-22).
2. `TelegramAdapter.deliverText()` (`src/adapters/telegram.ts:516`) sends/edits
   these status lines with `parse_mode: 'Markdown'`, where a bare `_` is an
   emphasis delimiter. Any interpolated value containing an underscore — a
   snake_case file path, a tool/module name like `search_transcripts`, a
   Python identifier — risks Telegram either mis-rendering the surrounding
   text as unintended italics, or rejecting the whole message as malformed
   Markdown (HTTP 400).
3. **Already visible in production**: the 400 case is caught and retried
   plain-text at `telegram.ts:519-522` (`console.error(...'retrying plain
   text')`), which recovers gracefully but silently drops all formatting for
   that message — masking the underlying problem rather than fixing it at
   the source.
4. **Fix**: wrap each interpolated dynamic field in backticks (inline code)
   in `tool-call-summary.ts` before it's embedded in a status line. Backtick
   spans are exempt from further Markdown parsing inside them (Telegram's
   Markdown dialect does not process `_`/`*`/etc. within a code span), so
   this neutralizes the underscore problem without hand-escaping every
   Markdown special character — and it's a better semantic fit anyway, since
   every one of these fields (a path, a URL, a search pattern, a tool name)
   conceptually *is* code/literal-text, not prose.

---

## Entry Criteria

- None. Purely additive formatting change inside a pure, already
  unit-testable function (`formatToolCallSummary`) — no new dependency, no
  config, no schema change.

---

## Exit Criteria

1. Every dynamic field currently interpolated raw in `tool-call-summary.ts`
   (`file_path`, `description`, `pattern`, `url`, `query`, and `name` in the
   generic fallback) is wrapped in backticks in the rendered status line.
2. A value that itself contains a backtick does not break out of the code
   span or produce malformed Markdown (see S34.1 acceptance criteria for the
   exact handling).
3. `MAX_FIELD_LENGTH` truncation (`truncateField()`, line 16-18) still
   applies to the field's raw content — truncate before wrapping, so the
   backtick pair itself is never counted against/split by the 200-char
   budget.
4. The known production symptom (`Markdown parse error for
   editMessageText/sendMessage, retrying plain text`) stops recurring for
   the underscore case specifically — existing malformed-Markdown fallback
   logic in `telegram.ts` is left in place as defense-in-depth, not removed.

---

## Stories

### S34.1 — Wrap interpolated fields in backticks in `formatToolCallSummary`

**User story:** As Mr. Patten watching the live tool-call status stream on
Telegram, I want status lines with underscored paths/names to render
correctly (or at least consistently, as code) instead of occasionally
breaking Markdown parsing and silently losing all formatting for that
message.

**Acceptance criteria:**
1. Update each `render` callback passed to `withField()` (Bash, Agent, Read,
   Edit, Write, Grep, WebFetch, WebSearch) to wrap the truncated field value
   in backticks: e.g. `` `🐚 ${d}` `` → `` `🐚 \`${d}\`` ``, `` `📖 Reading
   ${p}` `` → `` `📖 Reading \`${p}\`` ``, etc. — the emoji/verb prefix stays
   outside the code span, only the dynamic value goes inside it.
2. `genericFallback(name)` wraps `name` the same way: `` `⚙️ Running
   \`${name || 'tool'}\`` `` (only wrap when `name` is non-empty — an empty
   name already falls back to the literal word `tool`, which doesn't need
   backticks).
3. **Backtick-in-value handling**: if the field value itself contains a
   backtick (rare but possible in a file path or search pattern), replace it
   with a visually similar safe character (e.g. a single quote or the
   Unicode `´`) before wrapping, rather than leaving it unescaped — a raw
   backtick inside a backtick-delimited span would terminate the span early
   and reintroduce the exact problem this epic fixes. Add a small
   `escapeForCodeSpan()` (or similarly named) helper covering this one
   substitution; keep it minimal, not a general Markdown escaper.
4. Truncation (`truncateField`) still runs before wrapping, and before the
   backtick-substitution step in AC3, so the 200-char budget reflects the
   field's real content length, not the wrapper.
5. Unit tests: each tool case renders in backticks; a Grep `pattern`
   containing an underscore round-trips visually correct through a live (or
   mocked) `parse_mode: 'Markdown'` send without a 400; a value containing a
   backtick is safely substituted, not passed through raw.

**Complexity:** S

### S34.2 — Docs, CHANGELOG

**User story:** As a maintainer touching this formatter later, I want the
backtick-wrapping convention documented so it isn't accidentally reverted.

**Acceptance criteria:**
1. Add a short comment in `tool-call-summary.ts` (near `withField`/
   `genericFallback`) explaining *why* dynamic fields are backtick-wrapped
   (Telegram Markdown + underscores in paths/tool-names, E34) so a future
   edit doesn't strip it as unnecessary.
2. `CHANGELOG.md` entry under `[Unreleased]`.

**Complexity:** S

---

## Notes

- **Why backticks, not a general Markdown escaper.** Escaping every
  Markdown special character (`_`, `*`, `` ` ``, `[`, etc.) by hand in each
  interpolated value is more invasive and easier to get subtly wrong than
  wrapping the value in a code span, which is exempt from further parsing by
  definition and semantically correct for all six of these fields (paths,
  URLs, patterns, queries, tool names are all "literal text," not prose).
  Considered and rejected as unnecessary complexity for the same outcome —
  same reasoning shape as E32's join-vs-column decision.
- **Scope boundary**: this only touches the six known interpolation points
  inside `tool-call-summary.ts`. It does not touch `buildDraftTrail()`
  (`telegram.ts:245`) truncation logic, which operates on whole rendered
  lines and doesn't need to know about Markdown escaping — those lines
  arrive already safe once this epic lands.
- **Origin**: root-caused 2026-08-20 while debugging a scheduled-message
  channel-routing question, tied directly to recurring `Markdown parse
  error ... retrying plain text` log lines already visible in production.
  Never promoted until now; written up 2026-08-31 per Chris's request.
