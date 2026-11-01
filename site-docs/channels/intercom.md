# Intercom

Intercom puts a small, glanceable view of one of your conversations on a screen you keep nearby. It shows what your agent is doing right now, and when you speak to it from the screen, it shows the answer in a line or two. The first screen is a web app on your iPhone. A round desk device (the Compact) will use the same connection later.

Intercom follows a conversation you already have, usually your Telegram chat with your agent. It does not start a separate chat:

- What you type on Intercom goes into that conversation as if you had typed it in Telegram.
- Your agent sees that the message came from Intercom, and answers in a sentence or two.
- The reply shows on Intercom and in Telegram as normal. A small "⌨️ …" note appears in Telegram so the chat reads as a whole.
- Other messages in the chat never appear on Intercom. You only see the agent's status, and replies to what you sent from Intercom.

## What you see

- **Idle:** the time, the date and your day as a ring of coloured arcs (from your Mac's calendars).
- **Working:** the agent's short status line, such as "Checking the calendar", whoever started the turn.
- **Reply:** a one-line summary first, with the full text a tap away. "More on Telegram" appears when the reply has files, buttons or is long.

## Set it up

### 1. Configure the bus

Create a token for the screen and add the block to your config:

```sh
openssl rand -hex 24      # 48 characters; put it in the bus environment as INTERCOM_IPHONE_TOKEN
```

```yaml
adapters:
  intercom:
    interaction_grace_s: 120
    calendar:
      calendars: ["Home", "Family", "Work"]
    surfaces:
      - id: iphone-proto
        token_env: INTERCOM_IPHONE_TOKEN
        follow: { contact: me, channel: telegram:peggy }
```

| Option | Default | What it does |
|---|---|---|
| `interaction_grace_s` | `120` | How long replies keep showing on the screen after your agent finishes its turn, for follow-ups |
| `echo_to_followed` | `true` | Post the silent "⌨️ …" note in the followed chat |
| `event_retention_days` | `7` | How long a screen that was offline can catch up on missed replies |
| `calendar.calendars` | all | Calendars to draw on the ring, by the names Calendar uses. Case, emoji and punctuation don't matter |
| `calendar.cache_s` | `300` | How long the calendar is reused |
| `surfaces[].follow` | | `contact`, `channel`, and optionally `topic` to follow a Telegram forum topic |

Restart the bus after you add the block. Intercom's pages (`/intercom` and `/api/v1/intercom`) are the only ones a screen needs, so if you use Tailscale serve, expose just those two paths. They don't use `bus.auth_token`; each screen has its own token.

### 2. Pair a screen

Run this on the bus machine:

```sh
npx tsx scripts/intercom-pair.ts iphone-proto --base https://your-machine.your-tailnet.ts.net
```

It prints a one-time link ending in `/intercom/#pair=CODE`. Open it on the phone. The code works once and expires after 12 hours (change it with `--ttl`). Tap Share, then Add to Home Screen, to keep it as a full-screen app.

### 3. Tell your agent how to answer

Nothing to do: each Intercom message carries a short note asking the agent for a sentence or two and a one-line `glance`. See the [glance option](/reference/mcp-tools#messaging) on `reply` and `send_message`.

## Troubleshooting

| Problem | What to try |
|---|---|
| The pairing link says the code is used or expired | Run the pair command again for a fresh link |
| "Surface unavailable" when pairing | The surface's token variable isn't set in the bus environment, or is shorter than 32 characters. Set it and restart the bus |
| The ring is empty | The calendars in `calendar.calendars` don't match any name. Run `calctl calendars` and copy the names |
| Replies don't show | Replies appear only for messages you sent from Intercom, and for a couple of minutes after your agent finishes. A message you typed in Telegram doesn't open the window |
