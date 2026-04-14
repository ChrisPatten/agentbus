/**
 * Command system factory — wires the CommandRegistry with built-in handlers.
 *
 * Usage in src/index.ts:
 *
 *   const { registry: commandRegistry, pauseSet } = createCommandSystem({
 *     adapterRegistry: registry, queue, db, config,
 *   });
 *
 * Custom / plugin commands can be registered after this call:
 *
 *   commandRegistry.register({ name: 'my-cmd', ... });
 */
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { MessageQueue } from '../core/queue.js';
import { CommandRegistry } from './registry.js';
import { createBuiltinCommands, bindHelpToRegistry } from './handlers.js';

export type { CommandRegistry } from './registry.js';
export type {
  CommandDefinition,
  CommandHandler,
  CommandResponse,
  CommandManifest,
  SlashCommandContext,
} from './registry.js';

export interface CommandSystemDeps {
  adapterRegistry: AdapterRegistry;
  queue: MessageQueue;
  db: Database.Database;
  config: AppConfig;
}

export interface CommandSystem {
  registry: CommandRegistry;
  /** Set of adapter IDs currently paused — mutated by /pause and /resume */
  pauseSet: Set<string>;
}

/**
 * Instantiate the command system: create the registry, register all built-in
 * commands, bind the help handler to the registry, and return the system.
 */
export function createCommandSystem(deps: CommandSystemDeps): CommandSystem {
  const registry = new CommandRegistry();
  const pauseSet = new Set<string>();

  const builtins = createBuiltinCommands({
    adapterRegistry: deps.adapterRegistry,
    queue: deps.queue,
    pauseSet,
  });

  for (const cmd of builtins) {
    registry.register(cmd);
  }

  // Late-bind /help to the registry so it can list all commands including
  // any plugin commands registered after createCommandSystem() returns.
  bindHelpToRegistry(
    () => registry.list(),
    (name) => registry.lookup(name),
  );

  return { registry, pauseSet };
}
