# Slack Channel (n8n relay)

The `slack` channel (`src/adapters/slack.ts`) sends Slack DMs through a self-hosted n8n instance. AgentBus never calls the Slack API and never holds a Slack token: it POSTs to an n8n webhook, and an n8n workflow posts the message from its Slack bot. AgentBus only makes outbound HTTPS calls, so it works from a laptop behind NAT.

**Status: outbound POC (E76, S76.0).** AgentBus can send DMs. Receiving Slack messages (the n8n queue, polling, acks, threads) is planned in the rest of E76; see `_bmad-output/epics/E76-slack-n8n-relay.md`.

---

## Architecture

```
agent ── send_message(channel: slack) ──▶ message_queue ──▶ DeliveryWorker ──▶ SlackAdapter.send()
                                                                                 │
                       POST {webhook_url}  Authorization: Bearer <HS256 JWT>     ▼
                       {slack_user_id, message}  ──────────────────────▶ n8n Webhook (JWT Auth)
                                                                                 │
                                                                Slack: chat.postMessage to the user
```

`SlackAdapter` registers with `channels: ['slack']`, so `DeliveryWorker` hands every `contact:*` message on channel `slack` to `send()`. No pipeline, delivery, or MCP tool code is Slack-specific.

---

## Configuration

```yaml
adapters:
  slack:
    enabled: true                 # default true when the block is present
    webhook_url: https://n8n.example.com/webhook/agentbus/slack-dm
    jwt_secret: ${SLACK_JWT_SECRET}
    jwt_ttl_seconds: 60           # 10-3600
    request_timeout_ms: 10000     # 1000-60000

contacts:
  chris:
    id: chris
    displayName: Chris
    platforms:
      slack:
        user_id: U012ABCDEF       # Slack member id
```

| Key | Rules |
|---|---|
| `webhook_url` | Required. An `http(s)` URL: the n8n Webhook node's **production** URL. |
| `jwt_secret` | Required, at least 32 characters. The exact text of the n8n JWT credential's passphrase. |
| `contacts.<id>.platforms.slack.user_id` | Matches `^[UW][A-Z0-9]{2,}$`. Unique across contacts (config validation rejects duplicates). |

The adapter is registered only when `adapters.slack` is present and `enabled` is true.

---

## Webhook contract

```
POST {webhook_url}
Authorization: Bearer <JWT>
Content-Type: application/json

{ "slack_user_id": "U012ABCDEF", "message": "Build finished: 3 tests failing" }
```

The recipient is always a configured contact. `contact:<id>` resolves to `contacts.<id>.platforms.slack.user_id`, so an agent can only DM people listed in config. A contact without a Slack id fails without calling n8n.

| n8n response | `DeliveryResult` |
|---|---|
| 2xx, body not `{ok: false}` | `success: true`, `platformMessageId` = body `ts` (falls back to the envelope id) |
| 2xx with `{ok: false}` | failed, not retried |
| 400, 401, 403, other 4xx | failed, not retried. 401/403 also logs a `console.error` naming `jwt_secret`. |
| 429, 5xx | failed, `retryable: true` |
| timeout (`request_timeout_ms`), network error | failed, `retryable: true` |

Retryable failures go back through `DeliveryWorker`'s retry path (`MAX_RETRIES`). Reaction payloads are not supported and fail without retrying.

---

## JWT

`src/adapters/slack-jwt.ts` signs a fresh HS256 token per request, using `node:crypto` (no dependency).

| Claim | Value |
|---|---|
| `iss` | `agentbus` |
| `iat` | now, epoch seconds |
| `exp` | `iat + jwt_ttl_seconds` |
| `jti` | the bus message id |

The message text is in the body, never in the token. n8n's Webhook node with **JWT Auth** and a JWT credential of key type **Passphrase** and algorithm **HS256** verifies the signature and `exp`. n8n uses the passphrase string as the HMAC key, so AgentBus signs with `jwt_secret` as raw UTF-8 bytes. Don't base64-decode either side.

---

## Health

`health()` reports `healthy`, or `degraded` after 3 failed sends in a row. `details` has `consecutive_failures` and `last_error`, and `lastActivity` is the last successful send. One success resets it.

---

## Transcripts

`DeliveryWorker` logs an outbound transcript row after each delivered send. Until inbound Slack exists there is no `slack` conversation, so `resolveConversationForOutbound` returns `null` ids and the row is logged without a conversation or session.

---

## Network errors and TLS

A connection-level failure (`fetch failed`) is logged with undici's `cause` code, for example `ECONNREFUSED`, `ENOTFOUND`, or `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, and is retried. The TLS case usually means the process's CA store is wrong. On a machine behind Zscaler, `SSL_CERT_FILE` set to the Zscaler root alone replaces OpenSSL's whole store. Node then rejects hosts that Zscaler doesn't intercept and that present a normal public chain (observed on the internal n8n host, which is reached directly). The fix is a combined bundle (`/etc/ssl/cert.pem` plus the Zscaler root) in `SSL_CERT_FILE`, or unsetting it and using `NODE_EXTRA_CA_CERTS` for the Zscaler root. pm2 keeps the environment it was started with, so restart with `--update-env` from a shell that has the change.

---

## Security notes

- The JWT secret lets anyone holding it DM any Slack user the bot can reach. Treat it like a password. It sits in `config.yaml` or `.env` in plaintext, like other adapter secrets.
- Tokens expire after `jwt_ttl_seconds`, so a captured request can't be replayed later. `jti` is sent for future replay protection; n8n doesn't check it yet.
- Put a user-id allowlist in the n8n workflow's validation step to limit who the bot can DM, whatever AgentBus sends.

---

## Related

- `integrations/n8n/slack-relay/README.md`: n8n workflow setup
- `_bmad-output/epics/E76-slack-n8n-relay.md`: epic, including the planned inbound relay
- [docs/PEBBLE_ADAPTER.md](PEBBLE_ADAPTER.md): another webhook-based channel
