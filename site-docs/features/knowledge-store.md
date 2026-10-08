# Knowledge store

The knowledge store is a small database your agent can keep facts and records in: a list of your subscriptions, the details of a trip, the warranty on the dishwasher. Unlike notes in files, each record has a type, tags and dates, so the agent can find exactly what it needs later with a search.

It's always on. There's nothing to configure.

## How your agent uses it

Your agent manages the store with four tools:

| Tool | Does |
|---|---|
| `write_knowledge` | Saves a record: a `kind` (such as `subscription` or `trip`), a `title`, and the details as JSON. It can add tags, searchable fields (`facets`), dates, an importance and a confidence. |
| `search_knowledge` | Finds records by keywords, kind, tags, facet values or a date range. |
| `get_knowledge` | Reads one record in full. |
| `forget_knowledge` | Retires a record: replaces it with a newer one, marks it expired, or deletes it. |

You don't call these yourself. Ask your agent to "remember", "look up" or "forget" things, and describe in its instructions what kinds of records it should keep.

A record that's been replaced by a newer one, or that has passed its expiry date, no longer shows up in searches. It's kept, and can still be read by its ID, unless the agent deletes it.

## Things to know

- **Search is by keyword.** It matches whole words in the title, notes, details and tags. It doesn't understand meaning or match word endings: "flight" won't find "flights".
- **Each agent searches its own records.** Records belong to the agent that wrote them, and searches are filtered to one agent.
- **Expired records aren't removed** from the database. They're only hidden from searches.
- **The store isn't loaded into the agent's context automatically.** The agent looks things up when it decides it needs them.
