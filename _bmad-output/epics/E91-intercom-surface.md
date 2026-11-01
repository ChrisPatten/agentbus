# E91 — Intercom Surface

| Field | Value |
|---|---|
| Epic ID | E91 |
| Dependencies | E90 (follow engine), E59 (app protocol shapes reused), E93 (the web app that talks to it) |
| Story Count | 8 (5 done, 3 not started) |
| Estimated Complexity | L |
| Status | M0 backend built on `feat/e90-intercom-core` (not merged, not live). S91.6 to S91.8 not started |

Source: `data/intercom/intercom-prd.md` and `data/intercom/m0-contract.md`.

---

## Epic Summary

The transport and registry half of Intercom: surfaces with their own tokens, one-time pairing so a browser can obtain its token without it ever appearing in a URL, a static route for the web app, a calendar feed for the day-dial, and a WebSocket with the app channel's frame shape and cursor replay. The follow behaviour lives in E90.

## Design Decisions

| Decision | Choice |
|---|---|
| Socket (PRD Q2) | A sibling route `/api/v1/intercom/ws` with its own durable event table, not an extension of the app socket. Browsers cannot set headers, auth is a hello frame, and the semantics (follow, window) differ from session lists. The app socket is untouched. |
| Auth | Per-surface token from an env var. Browsers obtain it from a one-time pairing code (sha256 stored, `expires_at`, `used_at`) carried in the URL fragment. `bus.auth_token` is not required for the Intercom paths. |
| Events | Per-surface `seq` from a counter table (survives retention), 7-day retention, `reset: true` when the cursor is out of range. Durable: `reply`. Ephemeral: `activity`, `interaction`, `calendar`. |
| Calendar | `calctl show date:YYYY-MM-DD --output json`, filtered by name (case, emoji and punctuation ignored), cached, converted to the configured zone, stable per-calendar colours (calctl gives none). Stale copy served if calctl fails. |
| Static files | Hand-written route (no new dependency) with realpath containment, MIME map and `no-cache`; missing directory is 404. |
| Service object | `IntercomService` is built in `index.ts`, not a registry adapter: it has no delivery channel. |

## Exit Criteria (M0)

1. `scripts/intercom-pair.ts` prints a code and URL; the code works once, expires, is rate limited.
2. A bad token or a silent socket is closed with 4401; a good one gets `welcome`, replay, activity and calendar.
3. Replay by cursor and `reset` behave as specified.
4. `/intercom/` serves `apps/intercom-web/` and cannot read outside it.
5. `docs/INTERCOM.md`, `docs/HTTP_API.md`, `docs/MCP_TOOLS.md`, `site-docs/channels/intercom.md`, `config.yaml.example` and the changelog are updated.

## Stories

### S91.1 — Static route for the web app — done
`/intercom` redirect, `/intercom/*` from `apps/intercom-web/`, traversal and symlink safety, no auth, `no-cache`.

### S91.2 — Pairing — done
Migration 044 table, `POST /api/v1/intercom/pair` (400, 404, 410, 429, 503), per-address rate limit, `scripts/intercom-pair.ts`.

### S91.3 — Health and the calendar feed — done
`GET /api/v1/intercom/health`, `GET /api/v1/intercom/today`, `calendar` events (on connect, every 5 minutes, on date change).

### S91.4 — WebSocket protocol v1 — done
Hello-token handshake (4401), welcome, durable events with cursor replay and retention sweep, ephemeral events, `send`/`ack`/`state`/`ping`, heartbeat.

### S91.5 — Docs and bookkeeping — done
`docs/INTERCOM.md`, HTTP and MCP docs, site page, config example, changelog, epics, backlog and sprint status.

### S91.6 — Choice events and taps (M1) — not started
`choice` event and `choice` frame on the surface socket via the E86 path (pairs with S90.8).

### S91.7 — Notification delivery (with E89) — not started
Durable `notification` and ephemeral `attention` events, acknowledgement and action frames.

### S91.8 — Device state handling — not started
Act on `state` frames: quiet hours, battery and last-known state for inspection. M0 only stores and logs them.
