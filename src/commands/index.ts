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
import { createBuiltinCommands, createHelpHandler } from './handlers.js';
import { createSafeDatabase } from '../db/safe-database.js';

export type { CommandRegistry } from './registry.js';
export type {
  CommandDefinition,
  CommandHandler,
  CommandResponse,
  CommandManifest,
  SlashCommandContext,
} from './registry.js';
export { createSafeDatabase } from '../db/safe-database.js';
export type { SafeDatabase } from '../db/safe-database.js';

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

  // Load persisted pause state from previous runs
  const pauseSet = new Set<string>();
  const pausedRows = deps.db
    .prepare('SELECT adapter_id, paused_by FROM paused_adapters')
    .all() as Array<{ adapter_id: string; paused_by: string }>;
  for (const row of pausedRows) {
    pauseSet.add(row.adapter_id);
    console.log(`[commands] Adapter "${row.adapter_id}" is paused (by ${row.paused_by} — persisted from previous run)`);
  }

  const builtins = createBuiltinCommands({
    adapterRegistry: deps.adapterRegistry,
    queue: deps.queue,
    pauseSet,
    db: deps.db,
  });

  for (const cmd of builtins) {
    registry.register(cmd);
  }

  // Register /help last — its handler captures the registry directly,
  // so it can list all commands including any registered after this point
  // (registry.list() is called at handler invocation time, not at creation).
  registry.register({
    name: 'help',
    description: 'List commands or show usage for a specific command',
    usage: '/help [command]',
    scope: 'bus',
    handler: createHelpHandler(registry),
  });

  return { registry, pauseSet };
}
