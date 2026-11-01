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

### 4. Turn on notifications (optional)

Notifications put a short "needs you soon" item on the screen: a leaving time, a bill due today, a draft waiting for your OK. See [Notifications](#notifications) below.

## Troubleshooting

| Problem | What to try |
|---|---|
| The pairing link says the code is used or expired | Run the pair command again for a fresh link |
| "Surface unavailable" when pairing | The surface's token variable isn't set in the bus environment, or is shorter than 32 characters. Set it and restart the bus |
| The ring is empty | The calendars in `calendar.calendars` don't match any name. Run `calctl calendars` and copy the names |
| Replies don't show | Replies appear only for messages you sent from Intercom, and for a couple of minutes after your agent finishes. A message you typed in Telegram doesn't open the window |

## The iPhone web app

Intercom is a small round display for your agent: your day around the rim, what the agent is doing right now, and a short answer when you send it a message. The iPhone web app is the prototype. You open it from your tailnet, and it can sit on the Home Screen like an app.

### What you see

| Screen | When |
|---|---|
| Day-dial | Nothing is happening. A 24-hour ring of today's diary (midnight at the top), a gold dot for now, the time, the date and your next appointment in amber. |
| Working | The agent has a turn running in the conversation Intercom follows. It shows the agent's status line with a turning gold arc. |
| Reply | The agent answered something you sent from Intercom. A short line first; tap to read all of it and scroll; double-tap to dismiss. |
| Done | A check mark and a few words for about two seconds after the exchange ends. |
| Needs you | Something is waiting for you. The dial glows amber (an urgent item pulses), with a title, one line of detail and up to three buttons plus **Got it**. |
| Quiet | Between 10 PM and 6:30 AM. A dim clock; nothing glows, and a line shows how many items are waiting. |

#### Notifications

When something needs you, the dial glows amber and shows what it is. Tap a button to answer: the choice goes to your agent as if you had typed it, and its reply shows on the dial. **Got it** just acknowledges the item and it goes away. If several items are waiting, "1 of 3" appears below the buttons; swipe left or right, or tap it, to move between them.

If the one-line detail is cut short, "Tap to read" appears under it; tap the text to see the whole message, scroll if it is long, and tap **Back** (or the text) to return to the buttons. **Got it** is always added for you, so an agent should not list its own.

A low-priority item does not glow. Instead a small brass dot and "1 note" appear under the date on the day-dial; tap it to read the item. A thin amber line around the day-dial's rim shows that something that needs you is waiting.

From 10 PM to 6:30 AM the dial stays dark: no glow, and the Quiet screen says how many items are waiting. The hours are fixed for now and follow the phone's clock.

Only replies to messages you sent from Intercom appear as replies. Everything still arrives in Telegram as usual, and "More on Telegram" tells you when the full answer lives there.

### Pair your phone

1. On your iPhone, open the Intercom address (`/intercom/`) in Safari and choose Share, then **Add to Home Screen**.
2. On the bus host, run `npx tsx scripts/intercom-pair.ts <surface_id>`. It prints a link ending in `#pair=...`.
3. Open Intercom from the Home Screen, paste the link (or just the code) into the box under the dial, and tap **Pair**.

If you are using Safari without installing, opening the pairing link directly pairs it and removes the code from the address.

Pairing codes work once and expire after 12 hours. To unpair a phone, press and hold the connection dot at the top left, then confirm.

### Use it

- Type under the dial and tap **Send**. The message goes into the followed conversation as if you had typed it there.
- Tap **Large** to fill the width of the phone; **True size** returns to the 1.75-inch dial. The choice is remembered.
- Add `?demo` to the address to see all the screens, including a notification sequence, with sample data and without a connection.

## Notifications

A notification is a short item your agent, a schedule or one of your own scripts puts on the screen, such as "Leave for the dentist in 20 min" or "Draft to Kate awaiting your OK". Important ones make the screen glow amber (urgent ones pulse), and an item can carry up to three buttons. Tapping "Got it" dismisses the item; tapping a button dismisses it and sends your choice to the agent, as if you had typed it in the conversation. The reply shows on the screen as usual.

Whatever the screen shows is also handed to the agent, quietly, for its next turn in that conversation. So when you say "what was that about?", the agent already knows what you were looking at and when.

### Turn it on

Add a `notifications` block next to `adapters` in `config.yaml` and restart the bus:

```yaml
notifications:
  enabled: true
  retention_days: 14
  api_tokens_env: [NOTIFY_TOKEN_AUTOMATIONS]
  context_to_followed: true
```

| Option | Default | What it does |
|---|---|---|
| `enabled` | `false` | Turns notifications on. Intercom must be on too. |
| `retention_days` | `14` | How long finished items are kept |
| `api_tokens_env` | none | Names of environment variables holding passwords (16 characters or more) that scripts use to post notifications. Leave empty to allow only your agents. |
| `context_to_followed` | `true` | Hand what the screen shows to the agent for its next turn in the followed conversation |
| `rate_limit_per_min` | `30` | How many notifications one source can post per minute |

### Raise one from a script

```bash
curl -X POST http://127.0.0.1:3000/api/v1/notifications \
  -H "Authorization: Bearer $NOTIFY_TOKEN_AUTOMATIONS" \
  -H "Content-Type: application/json" \
  -d '{"title": "Bill due today", "body": "Citi $2,410", "key": "bill-citi", "level": "attention", "source": "Bills", "expires_in_s": 86400}'
```

The same `key` while the item is still open updates it instead of adding a second one. To clear it, send `PATCH /api/v1/notifications?key=bill-citi` with `{"state": "resolved"}`. Keep these addresses on your own network; do not publish them to the internet.

### Let your agent raise them

Agents have three tools, `notify`, `update_notification` and `list_notifications` (see [MCP tools](/reference/mcp-tools#notifications)). The Intercom note each message carries tells the agent when to use them: `notify` for short-lived "needs you soon" items, a normal message for content, and a `notify` when background work started from the screen finishes.

### What the screen does

| Level | On the screen |
|---|---|
| `info` | No glow. A small note under the date |
| `attention` | Amber glow, the title, one line of detail and the buttons |
| `urgent` | The same, pulsing |

Items you've dismissed don't count toward the glow. An item with an `expires_in_s` goes away by itself. Quiet hours are handled by the screen. Escalating an urgent item to Telegram is not available yet.

