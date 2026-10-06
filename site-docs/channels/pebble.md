# Pebble

The Pebble channel turns voice notes from a Pebble Ring into messages for your agent. Press the ring, say "buy oat milk" or "remind me to call the dentist tomorrow", and the transcribed note arrives at your agent like any other message.

It's receive-only: the ring can't show a reply. Your agent can answer you on another channel with `send_message`, or you can [relay](/features/channel-relay) the note into a Telegram chat so the reply lands there.

## How it works

The ring transcribes your note and sends it to a web address you choose (a "webhook"). AgentBus provides that address at `/api/v1/webhooks/pebble` on the bus. Each request carries a token that identifies you, so the note arrives as a message from your contact.

The ring's app can't add the `Authorization` header AgentBus expects, so in practice you run a small forwarding service of your own (a "proxy") that receives the ring's request and passes it on to the bus with your token. Setting up that proxy is up to you.

## Set it up

Create a token:

```bash
openssl rand -hex 24
```

Add it to `.env`:

```
PEBBLE_TOKEN_ME=paste-the-token-here
```

Turn on the channel, give your contact the token, and route `pebble` to your agent:

```yaml
adapters:
  pebble: {}

contacts:
  me:
    id: me
    displayName: Me
    platforms:
      pebble:
        token: ${PEBBLE_TOKEN_ME}

pipeline:
  routes:
    - match: { channel: pebble }
      target: { adapterId: cc-headless, recipientId: agent:assistant }
```

| Option | Default | What it does |
|---|---|---|
| `enabled` | `true` | Turns the channel on. Leaving out `adapters.pebble` turns it off. |
| `max_body_bytes` | `65536` | Largest request accepted |
| `logging.enabled` | `false` | Save every incoming request to a file, for troubleshooting |
| `logging.dir` | `logs/webhooks` | Where request logs go, one file per day under `pebble/` |

Request logs include the text of your notes, but never your token. Turn logging off again once things work.

### Make the bus reachable from your proxy

The bus only accepts connections from its own computer by default. If your proxy runs on the same computer, you don't need to change anything. If it runs on another machine on your network, set:

```yaml
bus:
  host: 0.0.0.0
```

This opens **every** bus address to your network, not just the webhook, and most of them have no password. Only do it on a network you trust, and point your proxy at `/api/v1/webhooks/pebble` alone.

## What the proxy sends

```
POST /api/v1/webhooks/pebble
Authorization: Bearer <your token>
Content-Type: multipart/form-data

transcription = the spoken text
recordedAt    = when it was recorded, as a number
client        = ring
```

You can test it from a terminal on the bus's computer:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/webhooks/pebble -H "Authorization: Bearer YOUR-TOKEN" -F "transcription=buy oat milk" -F "recordedAt=1735000000" -F "client=ring"
```

A response containing `"queued":true` means your agent has the note.

| Response | Meaning |
|---|---|
| `200` with `"queued":true` | Accepted and sent to your agent |
| `200` with `"queued":false` | Accepted but not sent on; `reason` says why, for example a duplicate of a note sent seconds earlier, or a [relay](/features/channel-relay) that re-sent it on another channel |
| `400` | Not a form upload, or `transcription` or `recordedAt` is missing |
| `401` | Missing or unknown token |
| `413` | Request too large |
