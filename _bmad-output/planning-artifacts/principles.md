# AgentBus Principles

Core boundaries and design rules that should guide all feature decisions.

## What AgentBus Is

A **deterministic communications fabric** — a message routing and delivery layer with optional capability extensions. It is not an agent, does not reason about intent, and does not decide what agents should do.

## Core Principles

### 1. Deterministic routing
Routing is rule-based and fully configurable. The bus follows rules; it does not infer intent or make judgment calls. If routing behavior is surprising, it is a bug in the rules, not an emergent decision.

### 2. No content generation in the core
The bus core never calls an LLM. Scheduled prompts and auto-generated messages are templated/static — the bus delivers them, it does not author them.

### 3. Agents are autonomous; the bus is a courier
The bus moves messages. What an agent does with a message is entirely the agent's concern. The bus does not sequence agent actions, manage agent state, or coordinate multi-step workflows between agents.

### 4. Explicit over implicit
Routing, tool exposure, and agent targeting are all explicit via configuration. Nothing happens automatically unless a rule or schedule was deliberately set up by the user.

### 5. Identity resolution is a bus concern
The bus owns contact and identity resolution — mapping senders across channels to a canonical identity. Agents receive a resolved identity; they do not perform or second-guess resolution themselves.

### 6. Extensibility via plugins, not runtime agent extension
Agents cannot extend the bus at runtime. Bus behavior is extended through plugins — discrete, statically-loaded components declared in config. This keeps the bus surface predictable and auditable.

### 7. Protocol translation, not semantic translation
Adapters convert between channel wire formats (Telegram API, iMessage, MCP) and the internal envelope format. They do not interpret meaning. Semantic understanding stays in agents.

### 8. Loose coupling via MCP
Agents interact with the bus exclusively over MCP. The bus should be replaceable — or an agent swapped out — without changing the other side's behavior.

## Capability Extensions

Beyond core routing, AgentBus may expose two classes of extensions:

### Scheduled / auto-generated messages
The bus can emit messages to agents on a schedule (cron) or in response to events (e.g., inbound message triggers a prompt to a second agent). These are templated — the bus fills in context variables but does not generate free-form content.

### Script-backed MCP tools
Users can expose local scripts as MCP tools callable by agents:
- User writes a script (any language) that optionally accepts parameters and returns output
- User adds config declaring the tool: name, description, script path, parameter schema
- Bus wraps the script as an MCP tool and serves it to connected agents
- Config controls which agents can call which tools (per-tool agent allowlist)

This keeps capability extension in user code, not in the bus.

## Boundary Tests

When evaluating whether something belongs in AgentBus, apply these tests:

| Question | If yes → | If no → |
|---|---|---|
| Does it require understanding intent or content? | Agent | Bus |
| Does it work the same regardless of which agent is connected? | Bus | Agent |
| Is the behavior fully determined by config/rules? | Bus | Agent |
| Does it generate novel content? | Agent | Bus |
| Does it translate protocol without interpreting meaning? | Bus | Agent |
| Does it resolve who sent the message? | Bus | Agent |

## What AgentBus Is Not

- An orchestrator or planner
- An LLM or AI system
- A replacement for agent runtimes (Claude Code, Codex, etc.)
- A workflow engine that sequences agent actions
