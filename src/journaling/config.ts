/**
 * Effective per-agent journaling settings (E66 S66.1).
 *
 * Two config sources, one shape:
 *   - `agents.<id>.journaling` — the per-agent block (preferred).
 *   - `adapters.cc-headless[.<name>].journaling` — the pre-E66 block, kept as
 *     a deprecated alias. It applies to a headless agent that has no
 *     `agents.<id>.journaling` block, mapped to the chain `[cc-headless]`.
 *
 * Static compatibility: each journaler declares the runtime capabilities it
 * needs (`JOURNALER_REQUIREMENTS`). A chain entry the agent's runtime can
 * never satisfy is skipped at run time (on `cc-headless`, `system-message`
 * always falls through, by design). A chain with no compatible entry at all
 * is a startup error (`journalingRequirements`, consumed by
 * `collectRuntimeRequirements`). A chain whose last compatible entry is not
 * `script` can run out of options; `chainExhaustionRisk` reports it so the
 * bus raises an advisory.
 */
import {
  DEFAULT_CONSOLIDATION_CRON,
  DEFAULT_JOURNALING_PROMPT,
  JOURNALER_IDS,
  getCcHeadlessInstances,
  getCcPoolInstances,
  type AppConfig,
  type JournalerId,
} from '../config/schema.js';
import { missingCapabilities, type RequiredCapability } from '../core/runtime-capabilities.js';
import type { AgentRuntime, RuntimeRequirement } from '../core/runtime-resolver.js';
import { DEFAULT_CONSOLIDATION_PROMPT } from './prompt.js';

export { JOURNALER_IDS, type JournalerId };

/** Static runtime capabilities each built-in journaler needs (decisions doc, S66.6–S66.8). */
export const JOURNALER_REQUIREMENTS: Readonly<Record<JournalerId, readonly RequiredCapability[]>> = Object.freeze({
  'system-message': Object.freeze(['systemMessages', 'liveAgent', 'exclusiveSession'] as RequiredCapability[]),
  'cc-headless': Object.freeze(['sessionResume'] as RequiredCapability[]),
  script: Object.freeze([] as RequiredCapability[]),
});

/** Default per-run timeout (5 min). */
export const DEFAULT_JOURNAL_TIMEOUT_MS = 300_000;
/** Default `min_human_messages`. */
export const DEFAULT_MIN_HUMAN_MESSAGES = 2;
/** Default pause threshold (30 min), shared with the legacy block. */
export const DEFAULT_THRESHOLD_MS = 1_800_000;

export interface ScriptJournalerSettings {
  command: string;
  args: string[];
  timeoutMs: number;
  env: Record<string, string>;
  model: string | null;
}

/** E68 S68.1 — the agent's consolidation pass. */
export interface ConsolidationSettings {
  enabled: boolean;
  cron: string;
  /** IANA zone for `cron`; null = the bus host's local zone. */
  timezone: string | null;
  prompt: string;
  /** Line budget for MEMORY.md (≤ the native 200-line load limit). */
  maxMemoryLines: number;
  timeoutMs: number;
}

/** Native auto memory loads the first 200 lines / 25 KB of MEMORY.md. */
export const NATIVE_MEMORY_MAX_LINES = 200;
export const NATIVE_MEMORY_MAX_BYTES = 25 * 1024;

export interface JournalingSettings {
  /** Prefixed logical agent id (a pool's id, never a pane id). */
  agentId: string;
  /** Where the settings came from. `cc-headless` = the deprecated alias. */
  source: 'agents' | 'cc-headless';
  enabled: boolean;
  /** Configured chain, in order (not yet filtered by runtime). */
  chain: JournalerId[];
  thresholdMs: number | Record<string, number>;
  ceilingMs: number | null;
  minHumanMessages: number;
  timeoutMs: number;
  /** Journaling-level model: `journaling.model`, else the runtime's own model, else null (CLI default). */
  model: string | null;
  prompt: string;
  journalers: {
    'system-message': { timeoutMs: number; model: string | null; prompt: string };
    'cc-headless': { model: string | null; prompt: string };
    script: ScriptJournalerSettings | null;
  };
  /** E68 — consolidation. Disabled for the deprecated cc-headless alias. */
  consolidation: ConsolidationSettings;
}

const AGENT_PREFIX = 'agent:';
const toPrefixed = (id: string) => (id.startsWith(AGENT_PREFIX) ? id : `${AGENT_PREFIX}${id}`);

/** The model the agent's runtime instance is configured with, if any. */
function runtimeModel(config: AppConfig, agentId: string): string | null {
  const id = toPrefixed(agentId);
  const headless = getCcHeadlessInstances(config).find((i) => toPrefixed(i.agent_id) === id);
  if (headless) return headless.model ?? null;
  const pool = getCcPoolInstances(config).find((i) => toPrefixed(i.agent_id) === id);
  return pool?.model ?? null;
}

/**
 * Every agent with journaling settings, keyed by prefixed logical agent id.
 * Agents configured under `agents.<id>.journaling` win over the legacy
 * cc-headless block for the same agent.
 */
export function resolveJournalingSettings(config: AppConfig): Map<string, JournalingSettings> {
  const out = new Map<string, JournalingSettings>();

  for (const [key, agent] of Object.entries(config.agents ?? {})) {
    const j = agent.journaling;
    if (!j) continue;
    const agentId = toPrefixed(key);
    const model = j.model ?? runtimeModel(config, agentId);
    const prompt = j.prompt ?? DEFAULT_JOURNALING_PROMPT;
    const timeoutMs = j.timeout_ms ?? DEFAULT_JOURNAL_TIMEOUT_MS;
    const script: ScriptJournalerSettings | null = j.script
      ? {
          command: j.script.command,
          args: [...(j.script.args ?? [])],
          timeoutMs: j.script.timeout_ms ?? timeoutMs,
          env: { ...(j.script.env ?? {}) },
          model: j.script.model ?? model,
        }
      : null;
    const chain = j.chain
      ? [...j.chain]
      : JOURNALER_IDS.filter((id) => id !== 'script' || script !== null);
    out.set(agentId, {
      agentId,
      source: 'agents',
      enabled: j.enabled ?? true,
      chain,
      thresholdMs: j.threshold_ms ?? { default: DEFAULT_THRESHOLD_MS },
      ceilingMs: j.ceiling_ms ?? null,
      minHumanMessages: j.min_human_messages ?? DEFAULT_MIN_HUMAN_MESSAGES,
      timeoutMs,
      model,
      prompt,
      journalers: {
        'system-message': {
          timeoutMs: j['system-message']?.timeout_ms ?? timeoutMs,
          model: j['system-message']?.model ?? model,
          prompt: j['system-message']?.prompt ?? prompt,
        },
        'cc-headless': {
          model: j['cc-headless']?.model ?? model,
          prompt: j['cc-headless']?.prompt ?? prompt,
        },
        script,
      },
      consolidation: {
        enabled: (j.enabled ?? true) && (j.consolidation?.enabled ?? true),
        cron: j.consolidation?.cron ?? DEFAULT_CONSOLIDATION_CRON,
        timezone: j.consolidation?.timezone ?? null,
        prompt: j.consolidation?.prompt ?? DEFAULT_CONSOLIDATION_PROMPT,
        maxMemoryLines: Math.min(j.consolidation?.max_memory_lines ?? NATIVE_MEMORY_MAX_LINES, NATIVE_MEMORY_MAX_LINES),
        timeoutMs: j.consolidation?.timeout_ms ?? timeoutMs,
      },
    });
  }

  // Deprecated alias: the cc-headless instance's own `journaling` block.
  for (const inst of getCcHeadlessInstances(config)) {
    const agentId = toPrefixed(inst.agent_id);
    if (out.has(agentId)) continue;
    const legacy = inst.journaling;
    const model = inst.model ?? null;
    const prompt = legacy?.prompt ?? DEFAULT_JOURNALING_PROMPT;
    out.set(agentId, {
      agentId,
      source: 'cc-headless',
      enabled: legacy?.enabled ?? true,
      chain: ['cc-headless'],
      thresholdMs: legacy?.threshold_ms ?? { default: DEFAULT_THRESHOLD_MS },
      ceilingMs: legacy?.ceiling_ms ?? null,
      minHumanMessages: DEFAULT_MIN_HUMAN_MESSAGES,
      timeoutMs: DEFAULT_JOURNAL_TIMEOUT_MS,
      model,
      prompt,
      journalers: {
        'system-message': { timeoutMs: DEFAULT_JOURNAL_TIMEOUT_MS, model, prompt },
        'cc-headless': { model, prompt },
        script: null,
      },
      // The alias predates consolidation; configure agents.<id>.journaling to get it.
      consolidation: {
        enabled: false,
        cron: DEFAULT_CONSOLIDATION_CRON,
        timezone: null,
        prompt: DEFAULT_CONSOLIDATION_PROMPT,
        maxMemoryLines: NATIVE_MEMORY_MAX_LINES,
        timeoutMs: DEFAULT_JOURNAL_TIMEOUT_MS,
      },
    });
  }

  return out;
}

/** Chain entries the runtime can statically support, in chain order. */
export function compatibleChain(chain: readonly JournalerId[], runtime: Pick<AgentRuntime, 'capabilities'>): JournalerId[] {
  return chain.filter((id) => missingCapabilities(runtime.capabilities, JOURNALER_REQUIREMENTS[id]).length === 0);
}

/**
 * Static requirements for `collectRuntimeRequirements` (E64). Nothing is
 * required while at least one chain entry fits the agent's runtime. When none
 * does, one requirement per entry is returned, so the startup error lists
 * what each journaler is missing. An agent with journaling settings but no
 * runtime gets an empty requirement, which fails as "has no runtime".
 */
export function journalingRequirements(
  config: AppConfig,
  resolver: { resolve(agentId: string): AgentRuntime | undefined },
): RuntimeRequirement[] {
  const reqs: RuntimeRequirement[] = [];
  for (const settings of resolveJournalingSettings(config).values()) {
    if (!settings.enabled) continue;
    const runtime = resolver.resolve(settings.agentId);
    if (!runtime) {
      reqs.push({ feature: 'journaling', agentId: settings.agentId, requires: [] });
      continue;
    }
    if (compatibleChain(settings.chain, runtime).length > 0) continue;
    for (const id of settings.chain) {
      reqs.push({ feature: `journaling chain: ${id}`, agentId: settings.agentId, requires: JOURNALER_REQUIREMENTS[id] });
    }
  }
  return reqs;
}

/**
 * Why the chain can run out of options, or null when it can't. Every
 * journaler except `script` depends on session or agent state (a pane still
 * leased, a transcript still on disk), so a chain whose last runnable entry
 * is not `script` can be exhausted.
 */
export function chainExhaustionRisk(settings: JournalingSettings, runtime: Pick<AgentRuntime, 'capabilities' | 'kind'>): string | null {
  if (!settings.enabled) return null;
  const runnable = compatibleChain(settings.chain, runtime);
  const last = runnable[runnable.length - 1];
  if (last === 'script') return null;
  const skipped = settings.chain.filter((id) => !runnable.includes(id));
  return (
    `The journaling chain [${settings.chain.join(', ')}] ends with ${last ?? 'nothing runnable'} on ${runtime.kind}` +
    (skipped.length > 0 ? ` (${skipped.join(', ')} never run${skipped.length === 1 ? 's' : ''} there)` : '') +
    ', which can be unavailable, so journal runs can fail with nothing left to try.'
  );
}

/** Advisory condition key for `chainExhaustionRisk`. */
export const CHAIN_RISK_CONDITION = 'journaling:chain-can-exhaust';

/** Effective pause threshold (ms) for a channel. */
export function thresholdForChannel(threshold: number | Record<string, number>, channel: string): number {
  if (typeof threshold === 'number') return threshold;
  return threshold[channel] ?? threshold['default'] ?? DEFAULT_THRESHOLD_MS;
}

/**
 * Paths under `adapters.cc-headless` where the raw (pre-validation) config
 * explicitly sets the deprecated `journaling` block. Used by the loader to
 * log a deprecation notice, since the validated config always carries the
 * block's defaults.
 */
export function legacyJournalingBlocks(raw: unknown): string[] {
  const headless = (raw as { adapters?: Record<string, unknown> } | null)?.adapters?.['cc-headless'];
  if (!headless || typeof headless !== 'object') return [];
  const rec = headless as Record<string, unknown>;
  if (typeof rec['system_prompt'] === 'string') {
    return 'journaling' in rec ? ['adapters.cc-headless.journaling'] : [];
  }
  return Object.entries(rec)
    .filter(([, v]) => v && typeof v === 'object' && 'journaling' in (v as object))
    .map(([name]) => `adapters.cc-headless.${name}.journaling`);
}
