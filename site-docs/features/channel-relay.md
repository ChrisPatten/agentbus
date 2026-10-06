# Channel relay

A relay re-sends a message as if it had arrived on another channel. The usual case is a Pebble voice note: instead of arriving on its own receive-only channel, it lands in your Telegram chat with the agent, where the agent's reply can reach you and the note sits alongside the rest of the conversation.

## How it works

When a message matches a relay rule, the bus:

1. rewrites its text using the rule's template;
2. sends it back in as a new message on the target channel, from the same sender;
3. discards the original.

The relayed message then goes through everything a message on that channel would: routing, the agent, and replies on that channel.

## Configure it

```yaml
pipeline:
  relays:
    - match: { channel: pebble, sender: contact:me }
      target:
        channel: telegram
        template: "🎙️ Voice note: {{body}}"
```

**Match** works like a [route's match](/concepts/contacts-and-routing#match): `channel`, `sender` and `topic`, all optional, all required to match if given. The first matching relay wins. One difference: relays run before topic rules, so `topic` only matches topics that arrive with the message, such as a `thread:` topic. It won't match a keyword topic like `code`.

**Target:**

| Field | Default | What it does |
|---|---|---|
| `channel` | required | The channel to re-send on, such as `telegram` or `telegram:sam` |
| `template` | <code v-pre>{{body}}</code> | The new message text |

The template can use:

| Placeholder | Becomes |
|---|---|
| <code v-pre>{{body}}</code> | The original message text |
| <code v-pre>{{sender}}</code> | The sender, such as `contact:me` |
| <code v-pre>{{channel}}</code> | The channel the message originally arrived on, such as `pebble` |

## Things to know

- **Make sure the target channel has a route.** The relayed message is routed like any other message on that channel.
- **Relays can't loop forever.** A message is relayed at most three times; after that it's handled on the channel it's on.
- **Extra details from the original are dropped.** For a Pebble note, the recording time isn't carried over to the relayed message.
- **The sender sees "not queued".** A Pebble request that's relayed gets `"queued":false` with the reason `Aborted at stage "channel-relay"`. That's expected: the relayed copy was queued instead.
