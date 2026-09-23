/**
 * E52 — stall watchdog config. The schema (src/config/schema.ts) leaves every
 * field optional; this applies the defaults.
 */
export interface WatchdogConfigInput {
  enabled?: boolean;
  observe_only?: boolean;
  sample_interval_ms?: number;
  stall_after_ms?: number;
  alert_contact?: string;
}

export interface ResolvedWatchdogConfig {
  enabled: boolean;
  observe_only: boolean;
  sample_interval_ms: number;
  stall_after_ms: number;
  alert_contact: string | undefined;
}

export const DEFAULT_WATCHDOG_SAMPLE_INTERVAL_MS = 30_000;
export const DEFAULT_WATCHDOG_STALL_AFTER_MS = 300_000;

export function resolveWatchdogConfig(raw?: WatchdogConfigInput): ResolvedWatchdogConfig {
  return {
    enabled: raw?.enabled ?? true,
    observe_only: raw?.observe_only ?? true,
    sample_interval_ms: raw?.sample_interval_ms ?? DEFAULT_WATCHDOG_SAMPLE_INTERVAL_MS,
    stall_after_ms: raw?.stall_after_ms ?? DEFAULT_WATCHDOG_STALL_AFTER_MS,
    alert_contact: raw?.alert_contact,
  };
}
