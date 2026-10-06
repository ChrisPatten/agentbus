/**
 * Runtime resolution and live capability checks (E64 S64.2).
 *
 * One lookup from any `agent_id` (bare or prefixed) to the runtime that hosts
 * it, built from config:
 *   - `adapters.cc-headless` instances          → `cc-headless`
 *   - `adapters.cc-pool` instances (the pool's logical id and every derived
 *     pane id, `<pool>-pool-<n>`)               → `cc-pool`
 *   - `pipeline.routes` targets with `adapterId: claude-code` → `claude-code`
 *   - any other route target addressed to an `agent:` recipient → `mcp-polled`
 *
 * When two sources claim the same id, the first in that order wins.
 * Agents that only receive messages through the implicit default route are
 * not resolvable: the bus cannot tell them from a typo. Add an explicit route.
 *
 * Live checks answer "can this capability be used for this session right
 * now?" — see `checkLive()`.
 */
import type Database from 'better-sqlite3';
import {
  getCcHeadlessInstances,
  getCcPoolInstances,
  type AppConfig,
  type CcHeadlessInstanceConfig,
  type CcPoolInstanceConfig,
} from '../config/schema.js';
import { claudeTranscriptExists } from '../adapters/claude-transcript.js';
import { getLastPollAt } from '../http/agent-liveness.js';
import type { PoolLeaseRow } from '../pool/types.js';
import {
  runtimeCapabilities,
  missingCapabilities,
  type RequiredCapability,
  type RuntimeCapabilities,
  type RuntimeCapability,
  type RuntimeKind,
} from './runtime-capabilities.js';

interface RuntimeBase {
  /** Prefixed agent id as asked for, e.g. "agent:peggy-pool-2". */
  agentId: string;
  kind: RuntimeKind;
  capabilities: Readonly<RuntimeCapabilities>;
}

export interface HeadlessRuntime extends RuntimeBase {
  kind: 'cc-headless';
  instance: CcHeadlessInstanceConfig;
  /** cwd of every `claude -p` turn; where Claude keeps its transcripts. */
  workingDir: string;
}

export interface PoolRuntime extends RuntimeBase {
  kind: 'cc-pool';
  pool: CcPoolInstanceConfig;
  /** The pool's prefixed logical id, e.g. "agent:peggy". */
  poolAgentId: string;
  /** Set when `agentId` is one pane's derived id rather than the pool's own. */
  paneAgentId?: string;
  workingDir: string;
}

export interface ClaudeCodeRuntime extends RuntimeBase {
  kind: 'claude-code';
}

export interface McpPolledRuntime extends RuntimeBase {
  kind: 'mcp-polled';
  /** The route target's `adapterId`. */
  adapterId: string;
}

export type AgentRuntime = HeadlessRuntime | PoolRuntime | ClaudeCodeRuntime | McpPolledRuntime;

/** A session to run a live check against. Pass what you have; ids are looked up when missing. */
export interface LiveCheckSession {
  agentId: string;
  conversationId?: string | null;
  /** Bus `sessions.id` — used to look up `claude_session_id` when not given. */
  sessionId?: string | null;
  claudeSessionId?: string | null;
}

export interface LiveCheckResult {
  ok: boolean;
  capability: RuntimeCapability;
  /** Unset when the agent did not resolve. */
  runtime?: RuntimeKind;
  /** Which check decided the result. */
  check: 'unresolved' | 'static' | 'pane-lease' | 'transcript' | 'polling';
  reason: string;
}

/** The slice of a PoolManager the resolver reads. */
export interface PoolLeaseLookup {
  poolId: string;
  leaseStore: { findByConversation(poolId: string, conversationId: string): PoolLeaseRow | null };
}

export interface RuntimeResolverDeps {
  /** Keyed by the pool's prefixed agent id, as built by `createPoolManagers()`. Needed for the pane-lease check. */
  poolManagers?: Map<string, PoolLeaseLookup>;
  /** Used to find a session's `claude_session_id` when the caller didn't pass it. */
  db?: Database.Database;
  transcriptExists?: (claudeSessionId: string, cwd: string) => boolean;
  /** ISO timestamp of the agent's last poll (bare id). Defaults to the bus's in-memory tracker. */
  lastPollAt?: (bareAgentId: string) => string | null;
  now?: () => Date;
  /** How recent a poll counts as "currently polling". Default: 3 poll intervals, at least 15 s. */
  pollFreshMs?: number;
}

/** A feature's static requirement on one agent's runtime. */
export interface RuntimeRequirement {
  /** Feature name used in the error, e.g. "journaling chain: system-message". */
  feature: string;
  agentId: string;
  requires: readonly RequiredCapability[];
}

const AGENT_PREFIX = 'agent:';
const toPrefixed = (id: string) => (id.startsWith(AGENT_PREFIX) ? id : `${AGENT_PREFIX}${id}`);
const toBare = (id: string) => (id.startsWith(AGENT_PREFIX) ? id.slice(AGENT_PREFIX.length) : id);

export class RuntimeResolver {
  private readonly headless = new Map<string, CcHeadlessInstanceConfig>();
  private readonly pools = new Map<string, CcPoolInstanceConfig>();
  /** Route-declared agents: prefixed id → adapterId. */
  private readonly routed = new Map<string, string>();
  private readonly deps: RuntimeResolverDeps;
  private readonly pollFreshMs: number;

  constructor(config: AppConfig, deps: RuntimeResolverDeps = {}) {
    this.deps = deps;
    for (const inst of getCcHeadlessInstances(config)) this.headless.set(toPrefixed(inst.agent_id), inst);
    for (const inst of getCcPoolInstances(config)) this.pools.set(toPrefixed(inst.agent_id), inst);
    // Optional chaining tolerates the partial configs tests build by cast.
    for (const rule of config.pipeline?.routes ?? []) {
      for (const target of [rule.target, ...(rule.also_notify ?? [])]) {
        if (!target.recipientId.startsWith(AGENT_PREFIX)) continue;
        if (target.adapterId === 'cc-headless' || target.adapterId === 'cc-pool') continue;
        if (!this.routed.has(target.recipientId)) this.routed.set(target.recipientId, target.adapterId);
      }
    }
    const pollIntervalMs = config.adapters?.['claude-code']?.poll_interval_ms ?? 1000;
    this.pollFreshMs = deps.pollFreshMs ?? Math.max(15_000, pollIntervalMs * 3);
  }

  /** Resolve an agent id (bare or prefixed) to its runtime, or undefined if no runtime hosts it. */
  resolve(agentId: string): AgentRuntime | undefined {
    const id = toPrefixed(agentId);

    const headless = this.headless.get(id);
    if (headless) {
      return {
        agentId: id, kind: 'cc-headless', capabilities: runtimeCapabilities('cc-headless'),
        instance: headless, workingDir: headless.working_dir ?? process.cwd(),
      };
    }

    const pool = this.findPool(id);
    if (pool) {
      const poolAgentId = toPrefixed(pool.agent_id);
      return {
        agentId: id, kind: 'cc-pool', capabilities: runtimeCapabilities('cc-pool'),
        pool, poolAgentId, ...(id !== poolAgentId ? { paneAgentId: id } : {}),
        workingDir: pool.working_dir ?? process.cwd(),
      };
    }

    const adapterId = this.routed.get(id);
    if (adapterId === 'claude-code') {
      return { agentId: id, kind: 'claude-code', capabilities: runtimeCapabilities('claude-code') };
    }
    if (adapterId) {
      return { agentId: id, kind: 'mcp-polled', capabilities: runtimeCapabilities('mcp-polled'), adapterId };
    }
    return undefined;
  }

  /** Every configured agent with its runtime, one entry per pool (not per pane), sorted by id. */
  list(): AgentRuntime[] {
    const ids = new Set<string>([...this.headless.keys(), ...this.pools.keys(), ...this.routed.keys()]);
    return [...ids]
      .sort()
      .map((id) => this.resolve(id))
      .filter((r): r is AgentRuntime => r !== undefined && !(r.kind === 'cc-pool' && r.paneAgentId));
  }

  /**
   * Can `capability` be used for `session` right now?
   *
   * Statically missing → not ok. Otherwise the live check, when the runtime
   * has one:
   *   - liveAgent / exclusiveSession on cc-pool: a pane is leased to this
   *     conversation (state `leased`).
   *   - liveAgent on claude-code / mcp-polled: the harness polled within
   *     `pollFreshMs`.
   *   - sessionResume / sessionFork: the Claude transcript for the session's
   *     `claude_session_id` is still on disk (Claude Code's
   *     `cleanupPeriodDays` deletes old ones).
   * Everything else passes on the static value alone.
   */
  checkLive(capability: RuntimeCapability, session: LiveCheckSession): LiveCheckResult {
    const runtime = this.resolve(session.agentId);
    if (!runtime) {
      return { ok: false, capability, check: 'unresolved', reason: `no runtime hosts ${toPrefixed(session.agentId)}` };
    }
    const base = { capability, runtime: runtime.kind };
    if (!runtime.capabilities[capability]) {
      return { ...base, ok: false, check: 'static', reason: `${runtime.kind} does not support ${capability}` };
    }

    if (capability === 'sessionResume' || capability === 'sessionFork') {
      if (runtime.kind !== 'cc-headless' && runtime.kind !== 'cc-pool') {
        return { ...base, ok: true, check: 'static', reason: 'supported' };
      }
      const claudeId = this.claudeSessionIdFor(session);
      if (!claudeId) {
        return { ...base, ok: false, check: 'transcript', reason: 'session has no claude_session_id' };
      }
      const exists = (this.deps.transcriptExists ?? claudeTranscriptExists)(claudeId, runtime.workingDir);
      return exists
        ? { ...base, ok: true, check: 'transcript', reason: `transcript ${claudeId} is on disk` }
        : { ...base, ok: false, check: 'transcript', reason: `transcript ${claudeId} is missing from ${runtime.workingDir}` };
    }

    if (runtime.kind === 'cc-pool' && (capability === 'liveAgent' || capability === 'exclusiveSession')) {
      return { ...base, ...this.checkPaneLease(runtime, session) };
    }

    if (capability === 'liveAgent' && (runtime.kind === 'claude-code' || runtime.kind === 'mcp-polled')) {
      const last = (this.deps.lastPollAt ?? getLastPollAt)(toBare(runtime.agentId));
      if (!last) return { ...base, ok: false, check: 'polling', reason: 'harness has not polled since bus start' };
      const ageMs = this.now().getTime() - new Date(last).getTime();
      return ageMs <= this.pollFreshMs
        ? { ...base, ok: true, check: 'polling', reason: `last poll ${Math.round(ageMs / 1000)}s ago` }
        : { ...base, ok: false, check: 'polling', reason: `last poll ${Math.round(ageMs / 1000)}s ago (stale after ${Math.round(this.pollFreshMs / 1000)}s)` };
    }

    return { ...base, ok: true, check: 'static', reason: 'supported' };
  }

  private checkPaneLease(runtime: PoolRuntime, session: LiveCheckSession): Omit<LiveCheckResult, 'capability' | 'runtime'> {
    if (!session.conversationId) {
      return { ok: false, check: 'pane-lease', reason: 'no conversation to check a pane lease for' };
    }
    const manager = this.deps.poolManagers?.get(runtime.poolAgentId);
    if (!manager) return { ok: false, check: 'pane-lease', reason: `pool ${runtime.poolAgentId} is not running` };
    const lease = manager.leaseStore.findByConversation(manager.poolId, session.conversationId);
    if (!lease) return { ok: false, check: 'pane-lease', reason: 'no pane is leased to this conversation' };
    if (lease.state !== 'leased') {
      return { ok: false, check: 'pane-lease', reason: `pane ${lease.pane_id} is ${lease.state}` };
    }
    return { ok: true, check: 'pane-lease', reason: `pane ${lease.pane_id} is leased to this conversation` };
  }

  private claudeSessionIdFor(session: LiveCheckSession): string | null {
    if (session.claudeSessionId) return session.claudeSessionId;
    const db = this.deps.db;
    if (!db) return null;
    if (session.sessionId) {
      const row = db.prepare('SELECT claude_session_id FROM sessions WHERE id = ?').get(session.sessionId) as
        | { claude_session_id: string | null }
        | undefined;
      return row?.claude_session_id ?? null;
    }
    if (session.conversationId) {
      const row = db
        .prepare(
          `SELECT claude_session_id FROM sessions
           WHERE conversation_id = ? AND claude_session_id IS NOT NULL
           ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT 1`,
        )
        .get(session.conversationId) as { claude_session_id: string } | undefined;
      return row?.claude_session_id ?? null;
    }
    return null;
  }

  /** The pool whose logical id is `id`, or whose derived pane ids (`<pool>-pool-<n>`) include it. */
  private findPool(id: string): CcPoolInstanceConfig | undefined {
    const direct = this.pools.get(id);
    if (direct) return direct;
    const match = /^(.+)-pool-\d+$/.exec(toBare(id));
    return match ? this.pools.get(toPrefixed(match[1]!)) : undefined;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/**
 * Validate static requirements against the resolved runtimes. Throws one
 * error listing every problem, each naming the feature, agent, runtime and
 * missing capabilities, so an impossible configuration fails at startup
 * rather than at the first run.
 */
export function validateRuntimeRequirements(
  resolver: Pick<RuntimeResolver, 'resolve'>,
  requirements: readonly RuntimeRequirement[],
): void {
  const problems: string[] = [];
  for (const req of requirements) {
    const runtime = resolver.resolve(req.agentId);
    if (!runtime) {
      problems.push(`  ${req.feature}: agent ${toPrefixed(req.agentId)} has no runtime (no cc-headless/cc-pool instance or agent route)`);
      continue;
    }
    const missing = missingCapabilities(runtime.capabilities, req.requires);
    if (missing.length > 0) {
      problems.push(`  ${req.feature}: agent ${runtime.agentId} runs on ${runtime.kind}, which lacks ${missing.join(', ')}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Runtime capability check failed:\n${problems.join('\n')}`);
  }
}

/**
 * Requirements that config-driven features place on agent runtimes.
 * Empty today: the first consumers (E65 advisories, E66 journaling chains)
 * add their entries here so `loadConfig()` rejects impossible configs.
 */
export function collectRuntimeRequirements(_config: AppConfig): RuntimeRequirement[] {
  return [];
}
