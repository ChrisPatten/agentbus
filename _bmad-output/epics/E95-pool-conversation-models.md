# E95 — cc-pool Per-Conversation Models and keep_warm

| Field | Value |
|---|---|
| Epic ID | E95 |
| Status | Complete (code, tests, docs; not merged or deployed) |
| Dependencies | E53 (pool model selection), E54 (`/model` catalog) |
| Story Count | 3 |
| Estimated Complexity | S |

E94 is reserved (backlog) for wake word and voiceprint, so this epic took E95.

## Epic Summary

Let one conversation, such as the operator's Intercom Telegram topic, run on its own model (Haiku, for speed) and keep its pane warm, while every other conversation keeps its current model.

## Stories

- **S95.1 Rules and resolution.** `adapters.cc-pool.<name>.conversation_models[]` (`match.channel`, optional `match.topic`, optional `match.contact`, `model`, `keep_warm`). `PoolManager.resolveModelFor()` resolves schedule model, then first matching rule (`source=conversation-rule`), then the existing agent/global/pool chain. Rule models are normalised through `resolveModelQuery()`; an unresolvable one is logged and dropped. The result depends only on channel, topic and contact, so reuse never flaps.
- **S95.2 keep_warm.** `LeaseStore.acquire()` takes `protectedConversationIds` and skips them when picking an eviction victim; `sweepHardIdle()` skips them too. Warm conversations are capped at capacity - 1. The warm set is in memory (repopulated on the next message after a restart).
- **S95.3 Tests and docs.** `pool-manager.test.ts`, `lease-store.test.ts`, `schema.test.ts`; `docs/CC_POOL_ADAPTER.md`, `site-docs/features/models.md`, `config.yaml.example`, CHANGELOG.

## Exit Criteria

1. A message in the ruled conversation launches and reuses a pane on the rule's model; others are unchanged.
2. A warm pane survives idle eviction and the hard-idle sweep; a pool never deadlocks on warm panes.
3. `npx tsc --noEmit` clean, `npx vitest run` green.
