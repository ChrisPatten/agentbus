/**
 * Consolidation timer (E68 S68.1).
 *
 * Each agent with `journaling.consolidation` enabled (the default for
 * `agents.<id>.journaling`) gets a pass on its own cron, default nightly at
 * 03:00 bus-local time. The timer is independent of the scheduler: it runs
 * on the journaling engine's tick and asks the engine for a `scheduled`
 * pass, which the engine skips when no session journal completed since the
 * last pass. A pass missed while the bus was down runs on the first tick
 * after start (and is skipped the same way when there is nothing new).
 *
 * `/journal consolidate` asks for a `manual` pass instead; it does not move
 * the timer.
 */
import { Cron } from 'croner';
import type { JournalingSettings } from './config.js';
import type { TriggerHandle } from './engine.js';

/** Next fire time of `cron` strictly after `after`, or null (pattern never fires again). */
export function nextConsolidationAt(cron: string, timezone: string | null, after: Date): Date | null {
  const job = new Cron(cron, { paused: true, ...(timezone ? { timezone } : {}) });
  try {
    return job.nextRun(after) ?? null;
  } finally {
    job.stop();
  }
}

export interface ConsolidationSchedulerDeps {
  engine: {
    allSettings(): JournalingSettings[];
    consolidate(agentId: string, reason: 'scheduled' | 'manual'): TriggerHandle;
    store: { lastConsolidation(agentId: string): string | null };
  };
  now?: () => Date;
  log?: (line: string) => void;
}

export class ConsolidationScheduler {
  /** Prefixed agent id → next fire time (ms). */
  private readonly next = new Map<string, number>();

  constructor(private readonly deps: ConsolidationSchedulerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private enabled(): JournalingSettings[] {
    return this.deps.engine.allSettings().filter((s) => s.enabled && s.consolidation.enabled);
  }

  /** When the agent's next scheduled pass is due, or null when it has none. */
  nextRunAt(agentId: string): Date | null {
    const settings = this.enabled().find((s) => s.agentId === agentId || s.agentId === `agent:${agentId}`);
    if (!settings) return null;
    const known = this.next.get(settings.agentId);
    if (known !== undefined) return new Date(known);
    return this.initial(settings);
  }

  /** First fire time: the first one after the last pass, else after now. */
  private initial(settings: JournalingSettings): Date | null {
    const last = this.deps.engine.store.lastConsolidation(settings.agentId);
    const from = last ? new Date(last) : this.now();
    try {
      return nextConsolidationAt(settings.consolidation.cron, settings.consolidation.timezone, from);
    } catch (err) {
      this.deps.log?.(`[journaling] ${settings.agentId}: bad consolidation cron: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Fire every pass that is due. Call on the engine tick. Never throws. */
  tick(): Array<{ agentId: string; handle: TriggerHandle }> {
    const fired: Array<{ agentId: string; handle: TriggerHandle }> = [];
    const now = this.now();
    for (const settings of this.enabled()) {
      try {
        let due = this.next.get(settings.agentId);
        if (due === undefined) {
          const first = this.initial(settings);
          if (!first) continue;
          due = first.getTime();
          this.next.set(settings.agentId, due);
        }
        if (now.getTime() < due) continue;
        fired.push({ agentId: settings.agentId, handle: this.deps.engine.consolidate(settings.agentId, 'scheduled') });
        const following = nextConsolidationAt(settings.consolidation.cron, settings.consolidation.timezone, now);
        if (following) this.next.set(settings.agentId, following.getTime());
        else this.next.delete(settings.agentId);
      } catch (err) {
        this.deps.log?.(`[journaling] consolidation timer for ${settings.agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return fired;
  }
}
