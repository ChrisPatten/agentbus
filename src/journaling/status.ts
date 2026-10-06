/**
 * Journaling observability (E66 S66.10): what `/journal`, the runs route and
 * the health summary report. Read-only over the engine, store and gate.
 */
import type Database from 'better-sqlite3';
import type { AdvisoryService } from '../advisories/service.js';
import type { AgentRuntime } from '../core/runtime-resolver.js';
import { compatibleChain } from './config.js';
import { hookHealth, type HookHealthEntry } from './events.js';
import { loadWindow } from './eligibility.js';
import type { JournalEngine } from './engine.js';
import type { JournalRunGate } from './journalers/system-message.js';
import type { JournalRunRow } from './store.js';

export interface ConversationJournalStatus {
  sessionId: string;
  sessionOpen: boolean;
  agentId: string | null;
  cursorAt: string | null;
  lastJournaledAt: string | null;
  /** Human messages past the cursor. */
  unjournaledHuman: number;
  minHumanMessages: number | null;
  pendingTrigger: string | null;
  inFlight: boolean;
  /** Open System Message run holding this conversation, if any. */
  heldBy: string | null;
}

export interface AgentJournalStatus {
  agentId: string;
  runtime: string | null;
  enabled: boolean;
  chain: string[];
  runnable: string[];
  minHumanMessages: number;
  consecutiveExhaustions: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
  backlogSince: string | null;
  backlogSessions: number;
  inFlight: boolean;
  hooks: HookHealthEntry[];
  advisories: Array<{ id: string; severity: string; title: string; state: string }>;
}

export interface JournalStatusDeps {
  db: Database.Database;
  engine: JournalEngine;
  resolver: { resolve(agentId: string): AgentRuntime | undefined };
  advisories?: Pick<AdvisoryService, 'listActive'>;
  gate?: Pick<JournalRunGate, 'runForConversation' | 'runForAgent'>;
  now?: () => Date;
}

export function conversationStatus(deps: JournalStatusDeps, conversationId: string): ConversationJournalStatus | null {
  const session = deps.engine.sessionForConversation(conversationId);
  if (!session) return null;
  const agent = deps.engine.agentForSession(session);
  const settings = agent ? deps.engine.settingsFor(agent.agentId) : undefined;
  const window = loadWindow(deps.db, { sessionId: session.id, cursorAt: session.journal_cursor_at ?? null, agentId: agent?.agentId ?? '' });
  const state = deps.engine.store.getState(session.id);
  return {
    sessionId: session.id,
    sessionOpen: session.ended_at === null,
    agentId: agent?.agentId ?? null,
    cursorAt: session.journal_cursor_at ?? null,
    lastJournaledAt: session.last_journaled_at ?? null,
    unjournaledHuman: window.humanTimes.length,
    minHumanMessages: settings?.minHumanMessages ?? null,
    pendingTrigger: state?.pending_trigger ?? null,
    inFlight: deps.engine.isInFlight(session.id),
    heldBy: deps.gate?.runForConversation(conversationId)?.runId ?? null,
  };
}

export function agentStatus(deps: JournalStatusDeps, agentId: string): AgentJournalStatus | null {
  const settings = deps.engine.settingsFor(agentId);
  if (!settings) return null;
  const runtime = deps.resolver.resolve(settings.agentId);
  const state = deps.engine.store.getAgentState(settings.agentId);
  const backlog = deps.engine.backlog({ agentId: settings.agentId }).get(settings.agentId);
  return {
    agentId: settings.agentId,
    runtime: runtime?.kind ?? null,
    enabled: settings.enabled,
    chain: [...settings.chain],
    runnable: runtime ? compatibleChain(settings.chain, runtime) : [],
    minHumanMessages: settings.minHumanMessages,
    consecutiveExhaustions: state?.consecutive_exhaustions ?? 0,
    lastSuccessAt: state?.last_success_at ?? null,
    lastFailureAt: state?.last_failure_at ?? null,
    lastFailure: state?.last_failure ?? null,
    backlogSince: backlog?.since ?? null,
    backlogSessions: backlog?.sessions ?? 0,
    inFlight: deps.engine.isAgentBusy(settings.agentId) || !!deps.gate?.runForAgent(settings.agentId),
    hooks: runtime ? hookHealth(deps.db, deps.engine.store, settings.agentId, runtime, deps.now?.() ?? new Date()) : [],
    advisories: (deps.advisories?.listActive(settings.agentId) ?? [])
      .filter((a) => a.condition_key.startsWith('journaling:'))
      .map((a) => ({ id: a.id, severity: a.severity, title: a.title, state: a.state })),
  };
}

/** Per-agent journaling summary for `/api/v1/health`. */
export function journalingHealth(deps: JournalStatusDeps): {
  status: 'ok' | 'warning' | 'critical';
  agents: Record<string, {
    enabled: boolean;
    chain: string[];
    backlog_age_ms: number | null;
    backlog_sessions: number;
    consecutive_exhaustions: number;
    last_success_at: string | null;
    last_failure_at: string | null;
    last_failure: string | null;
    in_flight: boolean;
  }>;
} {
  const now = (deps.now?.() ?? new Date()).getTime();
  const backlog = deps.engine.backlog();
  const agents: ReturnType<typeof journalingHealth>['agents'] = {};
  let worst: 'ok' | 'warning' | 'critical' = 'ok';
  for (const settings of deps.engine.allSettings()) {
    const state = deps.engine.store.getAgentState(settings.agentId);
    const b = backlog.get(settings.agentId);
    const ageMs = b?.since ? Math.max(0, now - new Date(b.since).getTime()) : null;
    const exhaustions = state?.consecutive_exhaustions ?? 0;
    agents[settings.agentId] = {
      enabled: settings.enabled,
      chain: [...settings.chain],
      backlog_age_ms: ageMs,
      backlog_sessions: b?.sessions ?? 0,
      consecutive_exhaustions: exhaustions,
      last_success_at: state?.last_success_at ?? null,
      last_failure_at: state?.last_failure_at ?? null,
      last_failure: state?.last_failure ?? null,
      in_flight: deps.engine.isAgentBusy(settings.agentId),
    };
    if (!settings.enabled) continue;
    const level = exhaustions >= 3 || (ageMs !== null && ageMs >= 24 * 3_600_000) ? 'critical' : exhaustions > 0 ? 'warning' : 'ok';
    if (level === 'critical' || (level === 'warning' && worst === 'ok')) worst = level;
  }
  return { status: worst, agents };
}

/** A `journal_runs` row for the API: `files_changed` parsed. */
export function runForApi(row: JournalRunRow): Omit<JournalRunRow, 'files_changed'> & { files_changed: string[] | null } {
  let files: string[] | null = null;
  if (row.files_changed) {
    try {
      const v = JSON.parse(row.files_changed) as unknown;
      files = Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : null;
    } catch {
      files = null;
    }
  }
  return { ...row, files_changed: files };
}
