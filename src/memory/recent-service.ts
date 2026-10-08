/**
 * Keeps every agent's `recent.md` current (E67 S67.2): at startup, after each
 * successful journal run, and at local midnight (the lookback window moves
 * even when no file changed). See docs/AGENT_MEMORY.md#recentmd.
 */
import type { AppConfig } from '../config/schema.js';
import type { AgentRuntime } from '../core/runtime-resolver.js';
import { formatLocalDate } from '../adapters/memory-context.js';
import { memoryLayout, resolveMemorySettings, resolveMemoryLayout, runtimeWorkingDir, type MemoryLayout } from './layout.js';
import { writeRecent, type RecentWriteResult } from './recent.js';

export type RecentReason = 'startup' | 'journaled' | 'midnight' | 'hook' | 'manual';

export interface RecentMemoryDeps {
  config: AppConfig;
  resolver: { resolve(agentId: string): AgentRuntime | undefined };
  now?: () => Date;
  log?: (line: string) => void;
}

const AGENT_PREFIX = 'agent:';
const toPrefixed = (id: string) => (id.startsWith(AGENT_PREFIX) ? id : `${AGENT_PREFIX}${id}`);

export class RecentMemory {
  private lastDate: string | null = null;
  /** Agents already told their memory dir is missing (logged once each). */
  private readonly warned = new Set<string>();

  constructor(private readonly deps: RecentMemoryDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  /** Layouts of every agent with memory settings, keyed by prefixed logical agent id. */
  layouts(): MemoryLayout[] {
    return [...resolveMemorySettings(this.deps.config).values()].map((s) =>
      memoryLayout(s, runtimeWorkingDir(this.deps.resolver.resolve(s.agentId))));
  }

  /** Layout for an agent (bare, prefixed or pane id). */
  layoutFor(agentId: string): MemoryLayout {
    return resolveMemoryLayout(this.deps.config, this.deps.resolver, toPrefixed(agentId));
  }

  /** Regenerate one agent's `recent.md`. Never throws. */
  regenerate(agentId: string, reason: RecentReason): RecentWriteResult {
    const layout = this.layoutFor(agentId);
    try {
      const result = writeRecent(layout, this.now());
      if (result.status === 'written') {
        const r = result.render!;
        this.log(
          `[memory] ${layout.agentId}: recent.md regenerated (${reason}; ${r.days.length} day(s)` +
            `${r.truncated ? `, truncated, ${r.omitted.length} left out` : ''})`,
        );
      } else if (result.status === 'skipped' && !this.warned.has(layout.agentId)) {
        this.warned.add(layout.agentId);
        this.log(`[memory] ${layout.agentId}: recent.md not generated: ${result.reason}`);
      }
      return result;
    } catch (err) {
      const reasonText = err instanceof Error ? err.message : String(err);
      this.log(`[memory] ${layout.agentId}: recent.md regeneration failed (${reason}): ${reasonText}`);
      return { status: 'skipped', path: layout.recentPath, reason: reasonText };
    }
  }

  regenerateAll(reason: RecentReason): void {
    this.lastDate = formatLocalDate(this.now());
    for (const layout of this.layouts()) this.regenerate(layout.agentId, reason);
  }

  /** Call periodically: regenerates everything once the local date changes. */
  tick(): void {
    const today = formatLocalDate(this.now());
    if (this.lastDate === null) {
      this.lastDate = today;
      return;
    }
    if (today !== this.lastDate) this.regenerateAll('midnight');
  }
}
