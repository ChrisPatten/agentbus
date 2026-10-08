# Siri

The Siri channel lets you ask your agent a question out loud on your iPhone and hear the answer. Say "Hey Siri, ask Peggy", speak your question, and Siri reads out your agent's reply. The bus holds the question open while your agent thinks, so a quick answer comes back in the same exchange.

It works with **Peggy**, a small iPhone app in the AgentBus repository that adds an "Ask Peggy" shortcut to Siri.

::: warning Proof of concept
The Siri channel and the Peggy app are an early version. Questions and quick answers work. Answers that take longer than Siri is willing to wait aren't delivered to your phone yet; see [Slow answers](#slow-answers).
:::

## How it works

1. You say "Hey Siri, ask Peggy" (or "Ask Peggy a question", "Talk to Peggy", "Hey Peggy") and speak your question.
2. Peggy sends the question to your bus over Tailscale, identifying you with your Siri token.
3. The bus passes it to your agent like any other message and waits for the reply, up to `reply_timeout_ms` (25 seconds by default).
4. If the agent answers in time, Siri speaks the answer. If not, Siri says the agent is still working on it.

Slash commands work too: ask Peggy "/status" and Siri reads the result.

## Set it up

### 1. Configure the bus

Create a token for your phone:

```bash
openssl rand -hex 24
```

Add it to `.env`:

```
SIRI_TOKEN_ME=paste-the-token-here
```

Then turn on the channel, give your contact the token and route `siri` to your agent:

```yaml
adapters:
  siri:
    reply_timeout_ms: 25000

contacts:
  me:
    id: me
    displayName: Me
    platforms:
      siri:
        token: ${SIRI_TOKEN_ME}

pipeline:
  routes:
    - match: { channel: siri }
      target: { adapterId: cc-headless, recipientId: agent:assistant }
```

Tell your agent, in its system prompt, that answers on `siri` are spoken aloud and should be short, with no Markdown.

| Option | Default | What it does |
|---|---|---|
| `enabled` | `true` | Turns the channel on |
| `reply_timeout_ms` | `25000` | How long the bus waits for the agent's answer, from 1,000 to 60,000. Siri gives up after about 30 seconds. |
| `max_body_bytes` | `8192` | Largest question the bus accepts. Questions can be up to 2,000 characters. |

### 2. Make the bus reachable from your phone

Your phone reaches the bus over [Tailscale](https://tailscale.com), a private network between your own devices. Install Tailscale on the Mac running the bus and on your iPhone, signed in to the same account.

On the Mac, share only the Siri part of the bus with your Tailscale network:

```bash
tailscale serve --bg --https=443 --set-path /api/v1/siri http://127.0.0.1:3000/api/v1/siri
```

Check that it's running:

```bash
tailscale serve status
```

Your bus address for the phone is `https://<your-mac's-name>.<your-tailnet>.ts.net`, as shown by `tailscale serve status`. Nothing else on the bus is exposed.

On the iPhone, turn on **Connect on Demand** in the Tailscale app, so Siri can reach the bus when you're away from home.

### 3. Install Peggy on your iPhone

Peggy is built with Xcode from `apps/ios/Peggy` in the AgentBus folder. It needs Xcode 27, an iPhone on iOS 27, and XcodeGen. The full steps, including signing it with your Apple ID and enabling Developer Mode on the phone, are in `apps/ios/Peggy/README.md`.

### 4. Connect Peggy

Open Peggy and fill in its settings:

| Field | What to enter |
|---|---|
| Bus URL | Your `https://….ts.net` address |
| Siri token | The token from `SIRI_TOKEN_ME` |
| Bus token | Leave empty |
| Wait for a reply | 20 seconds to start with (5–25) |

Tap **Test connection**. It shows the agent your questions are routed to.

## What Siri says

| Situation | What you hear |
|---|---|
| The agent answers in time | The agent's answer |
| The agent is still working | That Peggy is still working on it |
| You asked the same thing twice in a row | That you just asked, and to give it a moment |
| The token is wrong | That the token was rejected |
| The bus can't be reached | To check that Tailscale is connected |

## Slow answers

If your agent takes longer than the wait time, it still finishes and replies, and the reply is recorded in the conversation's transcript. It isn't delivered to your phone. You can ask your agent for it on another channel.

The configuration already accepts `late_reply_ttl_ms`, `rate_limit` and `fallback` (re-sending a late answer on another channel). The bus doesn't act on them yet.
