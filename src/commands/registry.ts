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
}

/** Response returned by a command handler */
export interface CommandResponse {
  /** Omit to send no reply at all — e.g. when a side effect (like finalizing
   * a Telegram draft) already gave the user their confirmation. */
  body?: string;
  metadata?: Record<string, unknown>;
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
  private readonly followUps = new Map<
    string,
    { command: string; validate: (body: string) => boolean; expiresAt: number }
  >();

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
      command,
      validate,
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
  ): { command: string; validate: (body: string) => boolean } | null {
    const key = `${channel}:${sender}`;
    const entry = this.followUps.get(key);
    if (!entry) return null;
    this.followUps.delete(key);
    if (Date.now() >= entry.expiresAt) return null;
    return { command: entry.command, validate: entry.validate };
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
