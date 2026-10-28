# Slack

The Slack channel lets your agent send you direct messages in Slack. Ask it to "DM me on Slack when the build finishes", or have a scheduled task post your morning summary there.

For now it's send-only: your agent can message you, but replies you type in Slack don't reach it yet.

## How it works

AgentBus doesn't talk to Slack itself. You run an [n8n](https://n8n.io) workflow with a Slack connection, and AgentBus sends each message to that workflow's web address (a "webhook"). The workflow posts the message to you as a DM from your Slack bot.

Each request carries a short-lived signed token (a JWT) that n8n checks, so only AgentBus can use the webhook. AgentBus only makes outgoing connections, so it works from a laptop without a public address.

## Set it up

Create a shared secret:

```bash
openssl rand -base64 48
```

Add it to `.env`:

```
SLACK_JWT_SECRET=paste-the-secret-here
```

In n8n, build the workflow described in `integrations/n8n/slack-relay/README.md`, under **Outbound DM**. Use the same secret as the JWT credential's passphrase. Copy the webhook's production URL.

Find your Slack member ID: in Slack, open your profile, click **⋯**, then **Copy member ID**.

Turn on the channel and give your contact the member ID:

```yaml
adapters:
  slack:
    webhook_url: https://n8n.example.com/webhook/agentbus/slack-dm
    jwt_secret: ${SLACK_JWT_SECRET}

contacts:
  me:
    id: me
    displayName: Me
    platforms:
      slack:
        user_id: U012ABCDEF
```

| Option | Default | What it does |
|---|---|---|
| `enabled` | `true` | Turns the channel on. Leaving out `adapters.slack` turns it off. |
| `webhook_url` | | Your n8n webhook's production URL (required) |
| `jwt_secret` | | Secret shared with n8n, at least 32 characters (required) |
| `jwt_ttl_seconds` | `60` | How long each signed token is valid |
| `request_timeout_ms` | `10000` | How long to wait for n8n before trying again later |

Restart AgentBus after changing the config.

## Send a message

Your agent sends with the `send_message` tool:

```
send_message(to: "contact:me", channel: "slack", body: "Build finished: 3 tests failing")
```

Your agent can only DM contacts that have a `slack.user_id`.

If n8n is down or Slack is busy, AgentBus tries again a few times. If n8n rejects the token, check that `jwt_secret` matches the n8n credential exactly. AgentBus logs this case.

## Troubleshooting

| Log message | Cause |
|---|---|
| `n8n webhook unreachable: … (UNABLE_TO_GET_ISSUER_CERT_LOCALLY …)` | AgentBus doesn't trust n8n's certificate. A common cause is `SSL_CERT_FILE` pointing at a single corporate proxy certificate (for example Zscaler), which replaces every other trusted root. Point `SSL_CERT_FILE` at a bundle that holds the standard roots plus the proxy's (`cat /etc/ssl/cert.pem proxy-root.pem > bundle.pem`), then restart AgentBus from a shell that has the new setting. |
| `n8n webhook HTTP 404` | Wrong URL, or the workflow isn't active. A test URL (`…webhook-test…`) only works while n8n is listening for a test event. |
| `n8n webhook HTTP 401` or `403` | `jwt_secret` doesn't match the n8n credential's passphrase. |
