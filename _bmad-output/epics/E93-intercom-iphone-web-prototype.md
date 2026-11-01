# E93 — Intercom iPhone Web Prototype

| Field | Value |
|---|---|
| Epic ID | E93 |
| Status | In progress (web app built; end-to-end check awaits the Intercom backend) |
| Dependencies | Intercom adapter and routes (E91, built on a parallel branch), `data/intercom/m0-contract.md` |
| Story Count | 5 |
| Estimated Complexity | M |

Source: `data/intercom/intercom-prd.md` section 4 and E93; the M0 contract wins where they differ.

## Epic Summary

A static web app, served at `/intercom/`, that renders Intercom's round dial on an iPhone at true size and talks to the Intercom WebSocket. No build step, framework or CDN.

## Stories

- **W1 (M0, done).** Render the screens at the round 466 profile, scaled to 268 CSS px (1.75 in), with a Large toggle; same visuals as the mockups; readability rules R1–R5; dark plain page outside the dial. Nine screens exist; the five not live in M0 appear in `?demo`.
- **W2 (M0, done).** Home Screen app: manifest, icons, standalone full-screen, safe areas, no zoom or rubber-band, wake lock. Served by the backend's static route (`apps/intercom-web/`, relative asset paths).
- **W3 (M0, done).** Real socket and auth from day one: pairing via `#pair=CODE`, hello and cursor, backoff, outbox with stable `client_msg_id`, ping, reset, 4401. Only `?demo` is server-free. A mock server stands in for the backend during development.
- **W4 (partly done; step 4 done Nov 1, 2026).** Delivery steps: 1. day-dial and status (done); 2. typed send with glance replies (done, needs the backend); 3. choices (screen built, not wired; M1); 4. notifications glow (done: Needs-you screen, note dot, rim halo, Quiet wired, `notification_ack` and `notification_action`; the backend is E89); 5. push-to-talk (screen built, not wired; E92).
- **W5 (M0, done).** Readability rules R1–R5 hold on every screen, checked against rendered screenshots.

## Exit Criteria

1. With the backend running, pairing, typed send, Working and Reply work on a real iPhone over the tailnet.
2. `npx vitest run apps/intercom-web` passes; docs in `docs/INTERCOM_WEB.md` and `site-docs/channels/intercom.md`.
