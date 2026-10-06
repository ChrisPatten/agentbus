# Choosing models

You decide which Claude model your agents use, and you can change it without restarting anything. Run your everyday chat on one model, switch an agent to a stronger model for a hard week, and run a routine check on a cheaper one.

This applies to `cc-headless` and `cc-pool`. A `claude-code` session uses whatever model you started it with.

## Where the model comes from

Each time the bus starts a turn (`cc-headless`) or a session (`cc-pool`), it picks the model from the first of these that's set:

| Order | Source | Set with |
|---|---|---|
| 1 | The scheduled job that triggered this turn | `model` on the [schedule](/features/scheduling) |
| 2 | An override for this agent | `set_model_override` with an `agent_id`, or the HTTP API |
| 3 | An override for all agents | `set_model_override` without an `agent_id`, or the HTTP API |
| 4 | The runtime's configuration | `model` under `adapters.cc-headless` or `adapters.cc-pool` |
| 5 | Claude Code's own default | Your agent folder's `.claude/settings.json`, or the CLI default |

Model names are whatever Claude Code accepts: `sonnet`, `opus`, `haiku`, or a full model ID.

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

A pane keeps its model for as long as its Claude session runs. When an override changes the model for a conversation that holds a pane, the bus restarts that pane's session with the new model before the next message, and the conversation carries on where it was. If the pane is still busy, the switch waits until it's finished.

## Checking which model ran

The bus log records the model and where it came from for every turn or launch, for example `Resolved model: haiku (source=schedule)`. `/pool` shows each pane's current model.
