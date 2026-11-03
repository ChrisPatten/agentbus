# Intercom devices

An Intercom screen is now a **device** paired to a **surface**. The surface is what your agents publish to: it follows one conversation, holds the items shown on the dial, and has its own list of agents allowed to publish. Each device paired to it, such as your iPhone, a desk Compact and a second phone, gets its own credential. You can list devices, give one a read-only view, and revoke one without touching the others.

You set up the surface itself on the [Intercom](/channels/intercom) page. This page covers pairing several devices, reaching them over your local network with a certificate, revoking a device, and what can appear on the dial.

## Pair a device

Run this on the bus machine, once per device:

```sh
npx tsx scripts/surface-pair.ts desk --name "Kitchen Compact"
```

It prints a one-time code, a link ending in `/intercom/#pair=CODE` and, when the LAN listener has a certificate, the certificate's fingerprint. Open the link on the device, or enter the code on the device. The code works once and expires after 12 hours.

| Option | Default | What it does |
|---|---|---|
| `--name` | `paired <date>` | The name you see in the device list |
| `--profile` | the surface's profile | The kind of screen, such as `round466` or `phone` |
| `--scope` | `interactive` | `read_only` lets the device show everything but not send messages or tap buttons |
| `--ttl` | `12h` | How long the code stays valid: `90m`, `12h`, `2d` |
| `--base` | your LAN listener address, if it's on | The address printed in the link |

A surface takes up to 10 devices (`max_devices`). Pairing one more fails with "device limit"; the code stays valid, so revoke a device you no longer use and try again.

`scripts/intercom-pair.ts` still works and pairs a device with the surface's default settings.

### Phones paired before devices existed

If a surface still has a `token_env`, the phone that was paired with that shared token keeps working: the bus treats the token as a device called `<surface>-legacy`. New surfaces don't need a `token_env` at all.

## See and revoke devices

```sh
npx tsx scripts/surface-devices.ts list            # every active device
npx tsx scripts/surface-devices.ts list desk --all # one surface, including revoked devices
npx tsx scripts/surface-devices.ts revoke desk-3f9a1c07
```

The list shows each device's id, surface, name, profile, scope, when it was paired and when it was last seen.

When you revoke a device, its credential stops working at once, and if it's connected the bus disconnects it within about five seconds. The device then asks to be paired again. Other devices on the surface stay connected.

Revoking the `-legacy` device lasts only until the bus restarts while the surface's `token_env` is still set. To remove it for good, delete `token_env` from the surface (or change the token) and restart the bus.

## Reach devices on your network

By default the bus only listens on your own computer. To let devices on your home network connect directly, turn on the surface listener. It's a separate, encrypted port that serves only the Intercom pages, never the rest of the bus.

### 1. Make a certificate

```sh
npx tsx scripts/surface-cert.ts
```

This creates a private certificate authority and a certificate for this computer's names and addresses in `~/.agentbus/surface-tls`, and prints the certificate's fingerprint and the config block to add. Add `--host` for each extra name or address devices use, for example `--host bobafett.local --host 192.168.1.20`.

### 2. Turn on the listener

Add the printed block to `config.yaml` and restart the bus:

```yaml
surface_api:
  enabled: true
  host: '0.0.0.0'
  port: 3443
  tls:
    cert: "/Users/you/.agentbus/surface-tls/server-chain.pem"
    key: "/Users/you/.agentbus/surface-tls/server.key"
```

| Option | Default | What it does |
|---|---|---|
| `enabled` | `false` | Start the encrypted listener for devices |
| `host` | `0.0.0.0` | Which network it listens on. `0.0.0.0` is every network this computer is on |
| `port` | `3443` | The port devices connect to |
| `tls.cert`, `tls.key` | none | The certificate and key files. Required: the listener won't start without them |
| `action_rate_limit_per_min` | `30` | Button taps one device can send per minute |
| `sessions.activity_timeout_min` | `30` | How long an idle agent session stays on the status face |
| `sessions.include_system` | `false` | Also show scheduled routines and agent-to-agent sessions |

The rest of the bus stays on `127.0.0.1`. The listener answers only the Intercom paths and turns everything else away, and it limits how many requests one address can make.

### 3. Let the device trust it

A device either pins the certificate's fingerprint (the pairing answer includes it, so a Compact can check it every time it connects) or trusts the certificate authority: install `~/.agentbus/surface-tls/ca.pem` on it. If you make a new certificate, re-pair devices that pinned the old fingerprint.

## What can appear on the dial

| Item | Where it comes from |
|---|---|
| **Events** | Cards your agents put on the dial, such as "Train in 10 min", with up to three buttons. An Event can carry a time, so it sits on the day ring, and it disappears when it expires |
| **Approvals** | When an agent's Claude Code session asks permission, the request also appears on every device of the surface that follows you, with the exact command or change and **Approve** and **Deny**. Your tap counts the same as a tap in Telegram |
| **Agent sessions** | Each agent session and what it's doing (working, waiting, stuck, finished, idle), with "needs you" when an agent has asked you a question it's waiting on. Idle and finished sessions drop off after 30 minutes unless they need you |
| **Notifications** | The same "needs you soon" items described under [Intercom notifications](/channels/intercom#notifications) |
| **Slot overrides and widgets** | Short temporary text on a face (at most a day), and data for small widgets |
| **Conversation** | A device can open a conversation's text, page back through it, and see new messages as they arrive |

Only agents listed in the surface's `publishers` can put Events, slot overrides and widgets on it:

```yaml
adapters:
  intercom:
    surfaces:
      - id: desk
        follow: { contact: me, channel: telegram:peggy }
        publishers: [peggy]      # or ["*"] for any agent
```

Agents use these tools:

| Tool | What it does |
|---|---|
| `list_surfaces` | Lists the surfaces the agent may publish to |
| `surface_publish_event` / `surface_remove_event` | Puts a card on the dial, with up to three buttons, or takes it off |
| `surface_set_slot` / `surface_clear_slot` | Overrides a slot on a face until a time you choose |
| `surface_write_widget` / `surface_remove_widget` | Writes the data a widget shows |
| `clear_answer_needed` | Clears the "needs you" mark on a conversation |

An agent may publish only to a surface whose `publishers` list includes it. When an agent asks you something it needs answered before it can go on, it can mark the reply `answer_needed`; the session then shows as needing you until you tap a button or reply.

### Buttons that send on your behalf

A button that would send a message for you, such as "Tell Sam I'm running late", always shows the exact text first. The device must send that same text back when you tap, or nothing is sent. Each button works once, and a tap after its card expires does nothing.

## Troubleshooting

| Problem | What to try |
|---|---|
| "Device limit" when pairing | The surface already has its maximum number of devices. Run `surface-devices.ts list`, revoke one you don't use, and pair again with the same code |
| A device keeps asking to pair | It was revoked, or its surface was removed from the config. Pair it again |
| A device on the network can't connect | Check `surface_api.enabled`, the port, and that the name or address the device uses was included with `--host` when you made the certificate |
| The bus won't start after turning on the listener | `tls.cert` and `tls.key` must point at readable files. The error names the file |
