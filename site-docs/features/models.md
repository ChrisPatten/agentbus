# Choosing models

You decide which Claude model your agents use, and you can change it without restarting anything. Run your everyday chat on one model, switch an agent to a stronger model for a hard week, and run a routine check on a cheaper one.

This applies to `cc-headless` and `cc-pool`. A `claude-code` session uses whatever model you started it with.

## Where the model comes from

Each time the bus starts a turn (`cc-headless`) or a session (`cc-pool`), it picks the model from the first of these that's set:

| Order | Source | Set with |
|---|---|---|
| 1 | The scheduled job that triggered this turn | `model` on the [schedule](/features/scheduling) |
| 2 | An override for this agent | [`/model`](#switching-from-chat) in chat, `set_model_override` with an `agent_id`, or the HTTP API |
| 3 | An override for all agents | `set_model_override` without an `agent_id`, or the HTTP API |
| 4 | The runtime's configuration | `model` under `adapters.cc-headless` or `adapters.cc-pool` |
| 5 | Claude Code's own default | Your agent folder's `.claude/settings.json`, or the CLI default |

Model names are whatever Claude Code accepts: `sonnet`, `opus`, `haiku`, or a full model ID.

## Switching from chat

Send `/model` in any chat to see which model the agent behind that chat uses, and change it:

| You send | What happens |
|---|---|
| `/model` | Shows the current model and where it comes from, with a picker of the latest model in each family |
| `/model opus` | Switches to the latest Opus model |
| `/model haiku 4.5` | Switches to that version. `opus 5` picks the newest Opus 5 release. |
| `/model claude-sonnet-5-5` | Switches to that exact model ID. An ID AgentBus doesn't know yet is used as written, with a warning. |
| `/model reset` | Removes the override, so the agent goes back to the model in its configuration |
| `/model list` | Every model AgentBus knows, by family, with older ones marked |

```text
You:   /model
Agent: Sam is on Sonnet 5.5 (claude-sonnet-5-5) — from config.
       [Fable 5.1] [Opus 5.5] [Sonnet 5.5 (current)] [Haiku 5.5]
You:   (tap Opus 5.5)
Agent: Sam → Opus 5.5 (claude-opus-5-5). Switched sam-pool:1 in place; the session is kept.
```

On Telegram the picker is a row of buttons. On other channels it's a numbered list: reply with the number to choose. Matching ignores case, and `claude` at the start is optional.

`/model` sets the override for the agent the chat routes to (row 2 above), so the change applies on every channel that reaches that agent. It works for chats routed to `cc-headless`, where it applies from the next message, or `cc-pool` (see [below](#with-cc-pool)). A scheduled job with its own `model` keeps it; the reply tells you if any do.

Built in are Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5, plus older Opus, Sonnet and Haiku releases. To add a new model before AgentBus knows about it, list it under [`models.catalog`](/reference/configuration#models).

## Overrides

Overrides take effect on the next turn, with no restart. Ask your agent ("switch yourself to opus for today"), or use the tools directly:

| Tool | Does |
|---|---|
| `set_model_override` | Sets the model for one agent (`agent_id: agent:sam`) or for every agent (no `agent_id`) |
| `get_model_override` | Shows the override that applies to an agent |
| `list_model_overrides` | Lists every override |
| `delete_model_override` | Removes one agent's override, the global one (`scope: global`), or all (`all: true`) |

The same is available over HTTP at `/api/v1/model-overrides`; see the [HTTP API](/reference/http-api#model-overrides). Overrides are stored in the bus database and last until you remove them.

`agent_id` is the full agent name, with `agent:` in front.

## With cc-pool

When you change the model with `/model` and your chat holds a pane that's between turns, the bus switches that pane straight away. It types `/model` into the session and confirms Claude Code's "Switch model?" question, so the session carries on without a restart. If that doesn't work, it restarts the pane's session with the new model instead, and the reply says why. If the pane is busy, nothing is typed into it and the switch happens with your next message.

An override set any other way, such as with `set_model_override`, reaches a pane at the conversation's next message: the bus restarts the pane's session with the new model, and the conversation carries on where it was.

Don't switch a pane by typing `/model` into it yourself, or by sending `//model`. The bus doesn't know about that change and may switch the pane back. Use `/model` in chat.

## Checking which model ran

The bus log records the model and where it came from for every turn or launch, for example `Resolved model: haiku (source=schedule)`. `/pool` shows each pane's current model.
