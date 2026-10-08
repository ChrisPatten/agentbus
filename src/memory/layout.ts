/**
 * Per-agent memory layout (E67 S67.1). See docs/AGENT_MEMORY.md.
 *
 * One place answers "where are this agent's memory files": journaling hands
 * the memory dir to journalers (E66), loading points Claude Code's native
 * auto memory at it or injects from it (S67.3), the `recent.md` generator
 * reads its dailies (S67.2), and consolidation archives into it (E68).
 *
 * Config sources, per field: `agents.<id>.memory` → the deprecated
 * `adapters.cc-headless[.<name>].memory` block of the agent's headless
 * instance → the defaults below. Paths are resolved against the agent's
 * working directory unless `dir` is absolute.
 */
import { isAbsolute, join } from 'node:path';
import { getCcHeadlessInstances, getCcPoolInstances, type AppConfig } from '../config/schema.js';
import type { AgentRuntime } from '../core/runtime-resolver.js';

export const DEFAULT_MEMORY_DIR = 'memory';
export const DEFAULT_INDEX_FILE = 'MEMORY.md';
export const DEFAULT_DAILY_SUBDIR = 'daily';
export const DEFAULT_LOOKBACK_DAYS = 3;
export const DEFAULT_RECENT_BUDGET_CHARS = 20_000;
/** Bus-generated digest of the recent dailies, inside the memory dir. Journalers never write it. */
export const RECENT_FILE = 'recent.md';
/** Retired content (E68 consolidation archives here, never deletes), inside the memory dir. */
export const ARCHIVE_SUBDIR = 'archive';

export interface MemorySettings {
  /** Prefixed logical agent id (a pool's id, never a pane id). */
  agentId: string;
  /** Where the settings came from: the agent block, the deprecated headless block, or nothing (defaults). */
  source: 'agents' | 'cc-headless' | 'default';
  dir: string;
  indexFile: string;
  dailySubdir: string;
  lookbackDays: number;
  recentBudgetChars: number;
  /** Load natively on runtimes with `nativeMemory` (false keeps bus injection). */
  native: boolean;
}

export interface MemoryLayout extends MemorySettings {
  /** The agent's working directory, when its runtime has one. */
  workingDir: string | null;
  /** Absolute memory dir, or null when it can't be resolved (relative `dir`, no working dir). */
  memoryDir: string | null;
  indexPath: string | null;
  dailyDir: string | null;
  recentPath: string | null;
  archiveDir: string | null;
}

const AGENT_PREFIX = 'agent:';
const toPrefixed = (id: string) => (id.startsWith(AGENT_PREFIX) ? id : `${AGENT_PREFIX}${id}`);

/** Effective settings for one logical agent (bare or prefixed id). Always returns settings (defaults if unconfigured). */
export function memorySettingsFor(config: AppConfig, agentId: string): MemorySettings {
  const id = toPrefixed(agentId);
  const agentBlock = Object.entries(config.agents ?? {}).find(([key]) => toPrefixed(key) === id)?.[1]?.memory;
  const headless = getCcHeadlessInstances(config).find((i) => toPrefixed(i.agent_id) === id)?.memory;
  const source: MemorySettings['source'] = agentBlock ? 'agents' : headless ? 'cc-headless' : 'default';
  return {
    agentId: id,
    source,
    dir: agentBlock?.dir ?? headless?.dir ?? DEFAULT_MEMORY_DIR,
    indexFile: agentBlock?.index_file ?? headless?.index_file ?? DEFAULT_INDEX_FILE,
    dailySubdir: agentBlock?.daily_subdir ?? headless?.daily_subdir ?? DEFAULT_DAILY_SUBDIR,
    lookbackDays: agentBlock?.lookback_days ?? headless?.journal_lookback_days ?? DEFAULT_LOOKBACK_DAYS,
    recentBudgetChars: agentBlock?.recent_budget_chars ?? DEFAULT_RECENT_BUDGET_CHARS,
    native: agentBlock?.native ?? true,
  };
}

/**
 * Settings for every agent that has a memory layout: each `agents.<id>.memory`
 * block, each cc-headless instance and each cc-pool pool. Keyed by prefixed
 * logical agent id.
 */
export function resolveMemorySettings(config: AppConfig): Map<string, MemorySettings> {
  const ids = new Set<string>();
  for (const [key, agent] of Object.entries(config.agents ?? {})) if (agent.memory) ids.add(toPrefixed(key));
  for (const inst of getCcHeadlessInstances(config)) ids.add(toPrefixed(inst.agent_id));
  for (const pool of getCcPoolInstances(config)) ids.add(toPrefixed(pool.agent_id));
  const out = new Map<string, MemorySettings>();
  for (const id of ids) out.set(id, memorySettingsFor(config, id));
  return out;
}

/** Absolute paths for `settings`, given the agent's working directory. */
export function memoryLayout(settings: MemorySettings, workingDir: string | null): MemoryLayout {
  const memoryDir = isAbsolute(settings.dir) ? settings.dir : workingDir ? join(workingDir, settings.dir) : null;
  return {
    ...settings,
    workingDir,
    memoryDir,
    indexPath: memoryDir ? join(memoryDir, settings.indexFile) : null,
    dailyDir: memoryDir ? join(memoryDir, settings.dailySubdir) : null,
    recentPath: memoryDir ? join(memoryDir, RECENT_FILE) : null,
    archiveDir: memoryDir ? join(memoryDir, ARCHIVE_SUBDIR) : null,
  };
}

/** The runtime's working directory, for the runtimes that have one. */
export function runtimeWorkingDir(runtime: AgentRuntime | undefined): string | null {
  return runtime && (runtime.kind === 'cc-headless' || runtime.kind === 'cc-pool') ? runtime.workingDir : null;
}

/** The logical agent id a runtime belongs to (a pool pane maps to its pool). */
export function logicalAgentId(runtime: AgentRuntime): string {
  return runtime.kind === 'cc-pool' ? runtime.poolAgentId : runtime.agentId;
}

/** Layout for an agent (bare, prefixed or pane id), resolved through its runtime. */
export function resolveMemoryLayout(
  config: AppConfig,
  resolver: { resolve(agentId: string): AgentRuntime | undefined },
  agentId: string,
): MemoryLayout {
  const runtime = resolver.resolve(toPrefixed(agentId));
  const logical = runtime ? logicalAgentId(runtime) : toPrefixed(agentId);
  return memoryLayout(memorySettingsFor(config, logical), runtimeWorkingDir(runtime));
}

/** Path of the daily journal for a local date `YYYY-MM-DD`, or null without a memory dir. */
export function dailyPath(layout: Pick<MemoryLayout, 'dailyDir'>, date: string): string | null {
  return layout.dailyDir ? join(layout.dailyDir, `${date}.md`) : null;
}

/**
 * Paths under `adapters.cc-headless` where the raw (pre-validation) config
 * explicitly sets the deprecated `memory` block. The validated config always
 * carries the block's defaults, so the loader checks the raw config.
 */
export function legacyMemoryBlocks(raw: unknown): string[] {
  const headless = (raw as { adapters?: Record<string, unknown> } | null)?.adapters?.['cc-headless'];
  if (!headless || typeof headless !== 'object') return [];
  const rec = headless as Record<string, unknown>;
  if (typeof rec['system_prompt'] === 'string') {
    return 'memory' in rec ? ['adapters.cc-headless.memory'] : [];
  }
  return Object.entries(rec)
    .filter(([, v]) => v && typeof v === 'object' && 'memory' in (v as object))
    .map(([name]) => `adapters.cc-headless.${name}.memory`);
}
