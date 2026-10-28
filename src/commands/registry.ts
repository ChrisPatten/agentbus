/**
 * Command Registry — maps slash command names to handler functions.
 *
 * Built-in bus commands (scope: "bus") are handled directly by bus-core
 * and never forwarded to the agent. Agent-scope commands (scope: "agent")
 * are forwarded to Peggy as command_invocation channel events.
 *
 * The registry is the extension point for custom commands: any code with
 * access to the registry can call register() to add a command at startup.
 */
import type { MessageEnvelope } from '../types/envelope.js';
import type { AppConfig } from '../config/schema.js';
import type { SafeDatabase } from '../db/safe-database.js';
import type { ProviderCommandForwarder } from './provider-forward.js';

/** Minimal command descriptor sent to adapters for autocomplete registration */
export interface CommandManifest {
  name: string;
  description: string;
}

/** Full command definition stored in the registry */
export interface CommandDefinition {
  name: string;
  description: string;
  /** Full usage string, e.g. "/pause <adapterId>" */
  usage: string;
  /** "bus" = handled inline; "agent" = forwarded to Peggy */
  scope: 'bus' | 'agent';
  handler: CommandHandler;
}

/** Context passed to every command handler */
export interface SlashCommandContext {
  /** Source channel, e.g. "telegram" */
  channel: string;
  /** Canonical sender ID, e.g. "contact:chris" */
  sender: string;
  /** ID of the adapter that received the message */
  adapterId: string;
  /** Raw unparsed args string */
  argsRaw: string;
  /** Full original message envelope */
  envelope: MessageEnvelope;
  /** Read-only database handle for queries (use HandlerDeps.db for writes) */
  db: SafeDatabase;
  /** Bus config */
  config: AppConfig;
  /** Route targets the pipeline resolved for this message (Stage 70), e.g.
   * `[{ adapterId: 'cc-pool', recipientId: 'agent:peggy' }]`. Lets a command
   * act on the agent this chat is routed to (E54 `/model`). */
  routes?: Array<{ adapterId: string; recipientId: string }>;
}

/** One option in an interactive picker returned by a command (E54). */
export interface CommandChoice {
  /** Button text / list line, e.g. 'Opus 5.5 (current)'. At most 64 characters (E74 limit). */
  label: string;
  /** What gets appended to the command when picked, e.g. 'claude-opus-5-5' */
  args: string;
}

/** A pending follow-up returned by {@link CommandRegistry.consumeFollowUp}. */
export type PendingFollowUp =
  | {
      /** Validator capture registered with `registerFollowUp` (E36) */
      kind: 'validate';
      command: string;
      validate: (body: string) => boolean;
    }
  | {
      /** Choice capture registered with `registerChoiceFollowUp` (E54) */
      kind: 'choice';
      command: string;
      choices: CommandChoice[];
      /** True if `body` selects one of `choices` */
      validate: (body: string) => boolean;
      /** The choice `body` selects, or null */
      match: (body: string) => CommandChoice | null;
    };

/**
 * Map a reply to one of `choices`: a bare number 1..n (1-based), or text
 * equal (case-insensitive, trimmed) to a choice's `args` or `label`.
 */
export function matchChoice(choices: CommandChoice[], body: string): CommandChoice | null {
  const text = body.trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n >= 1 && n <= choices.length) return choices[n - 1]!;
  }
  const lower = text.toLowerCase();
  if (!lower) return null;
  return (
    choices.find((c) => c.args.trim().toLowerCase() === lower || c.label.trim().toLowerCase() === lower) ?? null
  );
}

/** A PNG a command wants delivered as an image reply. */
export interface CommandImage {
  png: Buffer;
  caption: string;
  /** Sent as plain text instead when the originating adapter can't send images (or the send fails). */
  fallbackText: string;
}

/** Response returned by a command handler */
export interface CommandResponse {
  /** Omit to send no reply at all — e.g. when a side effect (like finalizing
   * a Telegram draft) already gave the user their confirmation. */
  body?: string;
  metadata?: Record<string, unknown>;
  /** Images to send as photo replies, in order; `body`, if also set, is sent as text alongside them. */
  images?: CommandImage[];
  /** Options for a picker (E54). On Telegram they ride the E74 choice-button
   * path (a tap runs `/<command> <choice.args>`); on other channels they are
   * appended as a numbered list and a reply like `2` picks one. At most 8
   * (E74 `MAX_CHOICES`); labels at most 64 characters. */
  choices?: CommandChoice[];
}

/** Async handler function — receives parsed args array and full context */
export type CommandHandler = (
  args: string[],
  context: SlashCommandContext,
) => Promise<CommandResponse>;

/**
 * CommandRegistry — stores and dispatches slash commands.
 *
 * Thread-safety note: all operations are synchronous Map reads/writes.
 * Node.js is single-threaded so no locking is needed.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();

  /**
   * Pending "check the next message from this sender" captures, keyed by
   * `${channel}:${sender}`. Generic (command name + validator closure) so
   * any command can register one, not just /torrent (E36).
   */
  private readonly followUps = new Map<string, { followUp: PendingFollowUp; expiresAt: number }>();

  /** Provider command forwarders, keyed by route `adapterId` (E71). */
  private readonly providers = new Map<string, ProviderCommandForwarder>();

  /**
   * Register the forwarder for a provider (e.g. "cc-pool"). Throws if that
   * provider already has one.
   */
  registerProvider(adapterId: string, forwarder: ProviderCommandForwarder): void {
    if (this.providers.has(adapterId)) {
      throw new Error(`Provider "${adapterId}" already has a command forwarder`);
    }
    this.providers.set(adapterId, forwarder);
  }

  /** The forwarder for a provider, or undefined if it doesn't accept commands. */
  provider(adapterId: string): ProviderCommandForwarder | undefined {
    return this.providers.get(adapterId);
  }

  /**
   * Register a command.
   * Throws if a command with the same name is already registered.
   */
  register(command: CommandDefinition): void {
    if (this.commands.has(command.name)) {
      throw new Error(`Command "${command.name}" is already registered`);
    }
    this.commands.set(command.name, command);
  }

  /**
   * Register a pending follow-up capture for the very next message from
   * `(channel, sender)`. Overwrites any existing entry for that key —
   * latest registration wins, it does not stack.
   */
  registerFollowUp(
    channel: string,
    sender: string,
    command: string,
    validate: (body: string) => boolean,
    ttlMs: number,
  ): void {
    this.followUps.set(`${channel}:${sender}`, {
      followUp: { kind: 'validate', command, validate },
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Register a pending choice capture for the very next message from
   * `(channel, sender)` — the numbered-list fallback for channels that can't
   * render E74 buttons (E54). A reply of `2`, or a choice's `args` or `label`
   * (case-insensitive), selects that choice. Shares the single slot with
   * `registerFollowUp`: latest registration wins.
   */
  registerChoiceFollowUp(
    channel: string,
    sender: string,
    command: string,
    choices: CommandChoice[],
    ttlMs: number,
  ): void {
    const list = [...choices];
    this.followUps.set(`${channel}:${sender}`, {
      followUp: {
        kind: 'choice',
        command,
        choices: list,
        validate: (body) => matchChoice(list, body) !== null,
        match: (body) => matchChoice(list, body),
      },
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Consume the pending follow-up for `(channel, sender)`, if any.
   * Single-shot: always deletes on read, whether or not the entry has
   * expired, so a second call immediately after always returns null.
   */
  consumeFollowUp(
    channel: string,
    sender: string,
  ): PendingFollowUp | null {
    const key = `${channel}:${sender}`;
    const entry = this.followUps.get(key);
    if (!entry) return null;
    this.followUps.delete(key);
    if (Date.now() >= entry.expiresAt) return null;
    return entry.followUp;
  }

  /**
   * Look up a command by exact name (without the leading slash).
   * Returns undefined if not found.
   */
  lookup(name: string): CommandDefinition | undefined {
    return this.commands.get(name);
  }

  /**
   * List all registered commands sorted alphabetically by name.
   */
  list(): CommandDefinition[] {
    return Array.from(this.commands.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /**
   * Return name+description pairs for adapter command registration.
   * Only includes bus-scope commands (agent-scope commands are internal).
   */
  manifests(): CommandManifest[] {
    return this.list()
      .filter((c) => c.scope === 'bus')
      .map(({ name, description }) => ({ name, description }));
  }
}
