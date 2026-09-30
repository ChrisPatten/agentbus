# E61 — Proactive Delivery to the App

| Field | Value |
|---|---|
| Epic ID | E61 |
| Status | Planned |
| Dependencies | E59 durable app events/offline send; existing scheduler and `send_message`; E53 schedule topic behavior where available |
| Story Count | 4 |
| Estimated Complexity | M |

Source: `planning-artifacts/mac-client/product-brief.md` §4–6 and `planning-artifacts/mac-client/PRD.md` §3.4 (FR-40–FR-44), flows F4–F5, §7. FR-43 can be delivered independently of E59.

## Epic Summary

Give scheduled and other system turns a dependable way to message the operator through the app. A topicless `send_message(channel: app)` lands in Main even when the client is closed; a named app topic is validated before delivery. The agent can discover topic titles. Overdue cron and one-off work obeys the specified wake behavior, and the prompt/config docs explain when to notify the operator.

## Exit Criteria

1. FR-40: topicless app send targets Main; an existing `thread:<hash>` targets that app session; an unknown app thread returns a clear error and never silently targets Main.
2. FR-41: `list_sessions` and `get_session` expose app-session `title` so the agent can choose a target by name.
3. FR-42: a scheduler turn stays hidden in the app sidebar; its app-directed message appears in Main or the selected topic and replays after offline delivery.
4. FR-43: a missed cron fires exactly once on the first post-wake/restart tick and advances from the current time; a missed one-off fires once unless `stale_after_ms` has elapsed. Existing scheduler behavior is verified or corrected with fake-clock tests.
5. FR-44: `docs/APP_ADAPTER.md` includes the agent's channel-guidance block and background-work pattern; `docs/SCHEDULING.md` states sleep/wake semantics. Config example and CHANGELOG are updated. A scripted offline cron-to-Main check passes.

## Stories

### S61.1 — App destinations and title discovery (FR-40/41)

Resolve an omitted app topic to `general` in `send_message`; validate explicit app thread topics against existing app sessions owned by the routed agent. Return a useful failure for unknown/deleted topics. Include `title` in agent-facing `list_sessions` and `get_session` output without changing other channels' identity rules. Test default Main, valid topic, invalid topic, and title lookup.

### S61.2 — Scheduler isolation and offline replay (FR-42)

Run a scheduled prompt in its scheduler session, then send to the app. Assert that the scheduler session is excluded by E59's listing rule, the outbound row/event belongs to the app destination, and `DeliveryWorker` acks it with zero sockets. Reconnect using an earlier cursor and verify one message event in the target session. Include a bus-restart case.

### S61.3 — Missed-fire behavior (FR-43)

Inspect the current scheduler's due-item and next-fire logic. Add fake-clock tests for multiple missed cron occurrences, an overdue one-off within `stale_after_ms`, and one beyond it. Fix only behavior that contradicts the PRD. Ensure a late tick does not start one cron turn per missed interval.

### S61.4 — Agent guidance, config, and verification (FR-44)

Document that scheduled work stays in its own session and calls `send_message(channel: app)` only when the operator needs an update. Include Main and topic examples, title discovery, offline behavior, and token/config setup in `APP_ADAPTER.md`; describe sleep/wake in `SCHEDULING.md`. Add relevant config example and CHANGELOG entry, then run targeted tests, full bus suite if code changed, and type check.

## Out of Scope

- Keeping the bus or Mac awake during laptop sleep.
- Delivering system/scheduler session history as sidebar items.
- macOS notification presentation (E62).
