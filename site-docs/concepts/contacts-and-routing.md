# Contacts and routing

Contacts decide **who** can talk to your agents. Routes decide **which agent** answers. Together they let one bus serve several people and several agents without anyone reaching an agent they shouldn't.

## Contacts

Every person who may message your agents is a contact in `config.yaml`. A contact lists the identities that person uses on each channel:

```yaml
contacts:
  alice:
    id: alice                 # must match the key above
    displayName: Alice
    platforms:
      telegram:
        userId: 123456789     # numeric Telegram user ID
      email:
        address:              # one address, or a list
          - alice@example.com
          - alice@work.example
      app:
        token: ${APP_TOKEN_ALICE}
      siri:
        token: ${SIRI_TOKEN_ALICE}
      pebble:
        token: ${PEBBLE_TOKEN_ALICE}
```

Inside the bus, this person is `contact:alice`. That's the name you use in routes, schedules and tools.

How each channel recognizes a contact:

| Channel | Identity | Unknown senders |
|---|---|---|
| Telegram | `telegram.userId` | Dropped, with a log line naming the sender's ID |
| Email | `email.address` (case-insensitive) | Dropped. Mail must also pass sender authentication; see [Email](/channels/email#who-can-email-your-agent) |
| Mac app | `app.token` (at least 16 characters) | Refused with `401 Unauthorized` |
| Siri | `siri.token` (at least 16 characters) | Refused with `401 Unauthorized` |
| Pebble | `pebble.token` | Refused with `401 Unauthorized` |

**Tokens are identities.** Anyone who has a contact's app, Siri or Pebble token can send messages as that contact, so make them long and random. On a Mac, this prints a suitable token:

```bash
openssl rand -hex 24
```

Each token must be unique. The bus refuses to start if two contacts share one.

## Routes

Routes live under `pipeline.routes`. Each route has a `match` and a `target`. The bus checks the routes in order and uses the **first** one that matches.

```yaml
pipeline:
  routes:
    # Alice's Telegram messages go to her own agent.
    - match: { channel: telegram, sender: contact:alice }
      target: { adapterId: cc-headless, recipientId: agent:alice-helper }

    # Everything else on Telegram, email and the Mac app goes to the main agent.
    - match: { channel: telegram }
      target: { adapterId: cc-headless, recipientId: agent:assistant }
    - match: { channel: email }
      target: { adapterId: cc-headless, recipientId: agent:assistant }
    - match: { channel: app }
      target: { adapterId: cc-headless, recipientId: agent:assistant }
```

### Match

All fields are optional. The fields you give must all match. A field you leave out matches anything.

| Field | Matches | Example |
|---|---|---|
| `channel` | The channel the message arrived on. `telegram` also matches that bot's group chats. | `telegram`, `telegram:work`, `email:personal`, `app` |
| `sender` | The contact who sent it | `contact:alice` |
| `topic` | The message's [topic](/concepts/conversations-and-sessions#topics) | `code` |

An empty `match: {}` matches everything. Put it last: the bus warns you at startup if a catch-all hides the routes after it.

::: tip Channel names are exact
`channel: telegram` doesn't match a second bot's `telegram:work`, and `channel: email` doesn't match `email:personal`. Add a route for each named bot or mailbox.
:::

### Target

| Field | Meaning |
|---|---|
| `adapterId` | The runtime that runs the agent: `cc-headless`, `cc-pool` or `claude-code` |
| `recipientId` | The agent: `agent:` followed by the runtime's `agent_id` |

`also_notify` sends a copy to more targets at the same time:

```yaml
    - match: { channel: email }
      target: { adapterId: cc-headless, recipientId: agent:assistant }
      also_notify:
        - { adapterId: cc-headless, recipientId: agent:archivist }
```

### Messages with no matching route

By default, a message that matches no route is still queued, addressed to the `claude-code` runtime. If you don't run that runtime, nothing picks it up. To discard unmatched messages instead, set:

```yaml
pipeline:
  drop_unrouted: true
```

## Priority

Every message is `normal`, `high` or `urgent`. Agents pick up more urgent messages first.

The bus scores each message from 0 to 100 and maps the score to a priority: 70 or more is `urgent`, 40 or more is `high`, anything lower is `normal`. Points come from:

| Rule | Points | Setting |
|---|---|---|
| Starting score | 0 | `pipeline.priority_weights.base_score` |
| Sender is in `pipeline.vip_contacts` | 20 | `priority_weights.vip_sender_bonus` |
| Message contains an urgency word | 15 | `priority_weights.urgency_keyword_bonus` |
| Message has a topic other than `general` | 40 | `priority_weights.topic_bonus` |

The urgency words default to `urgent`, `asap`, `emergency` and `critical`. Change them with `pipeline.urgency_keywords`. `vip_contacts` takes bare contact IDs, such as `[alice]`.

A message that already arrives as `high` or `urgent`, for example a scheduled job with `priority: urgent`, keeps its priority.
