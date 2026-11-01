# Intercom on iPhone

Intercom is a small round display for your agent: your day around the rim, what the agent is doing right now, and a short answer when you send it a message. The iPhone web app is the prototype. You open it from your tailnet, and it can sit on the Home Screen like an app.

## What you see

| Screen | When |
|---|---|
| Day-dial | Nothing is happening. A 24-hour ring of today's diary (midnight at the top), a gold dot for now, the time, the date and your next appointment in amber. |
| Working | The agent has a turn running in the conversation Intercom follows. It shows the agent's status line with a turning gold arc. |
| Reply | The agent answered something you sent from Intercom. A short line first; tap to read all of it and scroll; double-tap to dismiss. |
| Done | A check mark and a few words for about two seconds after the exchange ends. |

Only replies to messages you sent from Intercom appear as replies. Everything still arrives in Telegram as usual, and "More on Telegram" tells you when the full answer lives there.

## Pair your phone

1. On your iPhone, open the Intercom address (`/intercom/`) in Safari and choose Share, then **Add to Home Screen**.
2. On the bus host, run `npx tsx scripts/intercom-pair.ts <surface_id>`. It prints a link ending in `#pair=...`.
3. Open Intercom from the Home Screen, paste the link (or just the code) into the box under the dial, and tap **Pair**.

If you are using Safari without installing, opening the pairing link directly pairs it and removes the code from the address.

Pairing codes work once and expire after 12 hours. To unpair a phone, press and hold the connection dot at the top left, then confirm.

## Use it

- Type under the dial and tap **Send**. The message goes into the followed conversation as if you had typed it there.
- Tap **Large** to fill the width of the phone; **True size** returns to the 1.75-inch dial. The choice is remembered.
- Add `?demo` to the address to see all nine screens with sample data, without a connection.
