/**
 * Journaling evaluation engine (E66 S66.3). One path for every runtime.
 *
 * Triggers only ask for an evaluation. The engine journals a session only
 * when there is eligible content past its cursor and nothing is in flight
 * for it:
 *
 *   bus-side (always on)   pause      idle past the channel threshold; the idle clock
 *                                     starts at the latest of last inbound, last agent
 *                                     message and the last turn-ended event
 *                          ceiling    too long since the last journal (or session start)
 *                          close      SessionTracker closed the session
 *                          clear      bus /clear
 *                          evict,     cc-pool LRU eviction / hard-idle release
 *                          release
 *                          shutdown   bus stopping: pending state is persisted and
 *                                     journaled after restart ("preserve now, journal later")
 *                          manual     /journal now (part B)
 *   harness hooks          pre-compact, session-end, clear (final); turn-ended
 *   (optional, S66.4)      only re-anchors the pause clock
 *
 * Concurrency: single-flight per session (a trigger for a session that is
 * already queued merges into it; one that arrives while it runs schedules a
 * re-evaluation afterwards) and one run per agent at a time across all
 * journalers and sessions (a per-agent promise lane).
 *
 * Final triggers are persisted in `journal_state` the moment they fire, so a
 * restart re-evaluates them on the next tick.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getCcHeadlessInstances, type AppConfig } from '../config/schema.js';
import type { AgentRuntime, RuntimeResolver } from '../core/runtime-resolver.js';
import type { OwnerDirectory } from '../core/owners.js';
import type { SessionRow } from '../memory/types.js';
import type { JournalAdvisories } from './advisories.js';
import { NATIVE_MEMORY_MAX_BYTES, resolveJournalingSettings, thresholdForChannel, type JournalingSettings } from './config.js';
import { assessEligibility, eligibleSince, loadWindow, PENDING_MAX_AGE_MS } from './eligibility.js';
import type { JournalerRegistry } from './registry.js';
import { runChain, type ChainRunSummary } from './runner.js';
import { JournalStore } from './store.js';
import { isFinalTrigger, type JournalJob, type JournalTrigger } from './types.js';
import { memoryLayout, memorySettingsFor, runtimeWorkingDir } from '../memory/layout.js';
import { usesNativeMemory } from '../memory/native.js';
import { formatLocalDate } from '../adapters/memory-context.js';
import { consolidationPrompt } from './prompt.js';
import { BYPASS_KINDS, FeedbackStore, toFeedbackItem } from './feedback.js';

/** Dailies older than this many days may be archived by consolidation once promoted. */
export const ARCHIVE_DAILIES_AFTER_DAYS = 30;
const consolidationKey = (agentId: string) => `consolidate:${agentId}`;

/** Exhausted runs per window before non-manual triggers stop retrying it (new content re-arms). */
export const MAX_ATTEMPTS_PER_WINDOW = 3;
/** How often `journal_runs` retention is swept. */
const RETENTION_SWEEP_EVERY_MS = 60 * 60 * 1000;
/** Default wait for in-flight runs at shutdown. */
const DEFAULT_SHUTDOWN_WAIT_MS = 5_000;

export type EvaluationStatus =
  | 'journaled'        // chain ended done
  | 'nothing-to-do'    // chain ended nothing-to-do
  | 'exhausted'        // every journaler failed; cursor stays
  | 'nothing'          // no eligible content past the cursor
  | 'pending'          // below min_human_messages
  | 'attempt-cap'      // this window already exhausted MAX_ATTEMPTS_PER_WINDOW times
  | 'not-configured'   // no journaling settings / runtime for the session's agent
  | 'disabled'
  | 'unknown-session'
  | 'error';

export interface EvaluationResult {
  status: EvaluationStatus;
  sessionId?: string;
  agentId?: string;
  summary?: ChainRunSummary;
  error?: string;
}

export interface TriggerRequest {
  reason: JournalTrigger;
  /** Bus `sessions.id`. Either this or `conversationId`. */
  sessionId?: string;
  /** Resolved to the conversation's newest session (open first). */
  conversationId?: string;
}

export interface TriggerHandle {
  /** queued: a new evaluation; merged: joined one already queued or running. */
  status: 'queued' | 'merged' | 'not-configured' | 'disabled' | 'unknown-session';
  sessionId?: string;
  agentId?: string;
  /** Resolves when the evaluation this trigger joined has finished. Never rejects. */
  done: Promise<EvaluationResult>;
}

export interface JournalEngineDeps {
  db: Database.Database;
  config: AppConfig;
  resolver: Pick<RuntimeResolver, 'resolve'>;
  registry: JournalerRegistry;
  advisories?: JournalAdvisories;
  owners?: Pick<OwnerDirectory, 'isOwner'>;
  /** Defaults to `resolveJournalingSettings(config)`. */
  settings?: Map<string, JournalingSettings>;
  store?: JournalStore;
  /** E68 — feedback events. Default: a store over `db`. */
  feedback?: FeedbackStore;
  now?: () => Date;
  /** Default: `memory.summarizer_interval_ms` (the pre-E66 sweep cadence). */
  tickIntervalMs?: number;
  log?: (line: string) => void;
  newRunId?: () => string;
  /**
   * E67 — called after a chain ends `done` (status `journaled`), e.g. to
   * regenerate the agent's `recent.md`. Errors are logged, never thrown.
   */
  onJournaled?: (result: EvaluationResult) => void;
}

interface Slot {
  kind: 'session' | 'consolidate';
  /** Session id, or `consolidate:<agentId>` for consolidation. */
  sessionId: string;
  agentId: string;
  trigger: JournalTrigger;
  running: boolean;
  /** Strongest trigger that arrived while running; re-evaluated afterwards. */
  rerun: JournalTrigger | null;
  done: Promise<EvaluationResult>;
}

/** Remembered "nothing to do yet" results, so the tick doesn't reload unchanged windows. */
interface Memo {
  lastActivity: string;
  until: number;
}

const rank = (t: JournalTrigger) => (t === 'manual' ? 2 : isFinalTrigger(t) ? 1 : 0);
const stronger = (a: JournalTrigger | null, b: JournalTrigger) => (a === null || rank(b) > rank(a) ? b : a);
const AGENT_PREFIX = 'agent:';
const toPrefixed = (id: string) => (id.startsWith(AGENT_PREFIX) ? id : `${AGENT_PREFIX}${id}`);
const resolved = (r: EvaluationResult) => Promise.resolve(r);

export class JournalEngine {
  readonly store: JournalStore;
  /** E68 S68.2 — feedback events handed to journal runs. */
  readonly feedback: FeedbackStore;
  private readonly settings: Map<string, JournalingSettings>;
  private readonly slots = new Map<string, Slot>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly memo = new Map<string, Memo>();
  private readonly tickers: Array<() => void> = [];
  private readonly soleHeadlessKey: string | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRetentionSweep = 0;
  private stopped = false;

  constructor(private readonly deps: JournalEngineDeps) {
    this.store = deps.store ?? new JournalStore(deps.db, deps.now);
    this.feedback = deps.feedback ?? new FeedbackStore(deps.db, deps.now);
    // A new feedback event re-arms its conversation's evaluation on the next tick.
    this.feedback.onRecorded((row) => { if (row.conversation_id) this.forgetConversation(row.conversation_id); });
    this.settings = deps.settings ?? resolveJournalingSettings(deps.config);
    const headless = getCcHeadlessInstances(deps.config);
    this.soleHeadlessKey = headless.length === 1 ? toPrefixed(headless[0]!.agent_id) : null;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  /** Settings for a logical agent id (bare or prefixed), if journaling is configured. */
  settingsFor(agentId: string): JournalingSettings | undefined {
    return this.settings.get(toPrefixed(agentId));
  }

  /** Every agent with journaling settings. */
  allSettings(): JournalingSettings[] {
    return [...this.settings.values()];
  }

  /** Run `fn` on every tick (hook health, part B observability, …). */
  addTicker(fn: () => void): void {
    this.tickers.push(fn);
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  private findSession(req: { sessionId?: string; conversationId?: string }): SessionRow | null {
    if (req.sessionId) {
      return (this.deps.db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.sessionId) as SessionRow | undefined) ?? null;
    }
    if (req.conversationId) {
      return (this.deps.db
        .prepare(`SELECT * FROM sessions WHERE conversation_id = ? ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT 1`)
        .get(req.conversationId) as SessionRow | undefined) ?? null;
    }
    return null;
  }

  /**
   * The runtime and logical agent a session belongs to. Sessions without an
   * agent_id (pre-migration 011, single-instance deployments) fall back to
   * the sole cc-headless instance, as the pre-E66 sweep did.
   */
  agentForSession(session: Pick<SessionRow, 'agent_id'>): { agentId: string; runtime: AgentRuntime | undefined } | null {
    const key = session.agent_id ?? this.soleHeadlessKey;
    if (!key) return null;
    const runtime = this.deps.resolver.resolve(key);
    const agentId = runtime?.kind === 'cc-pool' ? runtime.poolAgentId : (runtime?.agentId ?? toPrefixed(key));
    return { agentId, runtime };
  }

  /** The conversation's newest session (open first), or null. */
  sessionForConversation(conversationId: string): SessionRow | null {
    return this.findSession({ conversationId });
  }

  /**
   * Unjournaled content per agent, for `/journal` and the health summary:
   * sessions with eligible human content past their cursor (open ones, and
   * closed ones with a pending final trigger), and when the oldest of it
   * became eligible (backlog age; below-threshold content counts only once
   * it is 24 h old or a final trigger fired). Looks at sessions active in
   * the last 30 days, at most `limit` of them.
   */
  backlog(opts: { agentId?: string; limit?: number } = {}): Map<string, { since: string | null; sessions: number; humanMessages: number }> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const rows = this.deps.db
      .prepare(
        `SELECT s.*, js.pending_since AS js_pending_since FROM sessions s LEFT JOIN journal_state js ON js.session_id = s.id
         WHERE (s.journal_cursor_at IS NULL OR s.journal_cursor_at < s.last_activity)
           AND s.last_activity > ?
           AND (s.ended_at IS NULL OR js.pending_trigger IS NOT NULL)
         ORDER BY s.last_activity DESC LIMIT ?`,
      )
      .all(cutoff, opts.limit ?? 200) as Array<SessionRow & { js_pending_since: string | null }>;
    const out = new Map<string, { since: string | null; sessions: number; humanMessages: number }>();
    for (const s of rows) {
      const agent = this.agentForSession(s);
      if (!agent?.runtime) continue;
      if (opts.agentId && agent.agentId !== toPrefixed(opts.agentId)) continue;
      const settings = this.settings.get(agent.agentId);
      if (!settings?.enabled) continue;
      const window = loadWindow(this.deps.db, { sessionId: s.id, cursorAt: s.journal_cursor_at ?? null, agentId: agent.agentId });
      if (window.humanTimes.length === 0) continue;
      const since = eligibleSince(window, { minHumanMessages: settings.minHumanMessages, pendingSince: s.js_pending_since, now });
      const entry = out.get(agent.agentId) ?? { since: null, sessions: 0, humanMessages: 0 };
      entry.sessions += 1;
      entry.humanMessages += window.humanTimes.length;
      if (since && (!entry.since || since < entry.since)) entry.since = since;
      out.set(agent.agentId, entry);
    }
    return out;
  }

  /** Drop the "nothing to do yet" memo of every session in a conversation. */
  private forgetConversation(conversationId: string): void {
    const ids = this.deps.db.prepare('SELECT id FROM sessions WHERE conversation_id = ?').all(conversationId) as Array<{ id: string }>;
    for (const { id } of ids) this.memo.delete(id);
  }

  /** True while an evaluation for the session is queued or running. */
  isInFlight(sessionId: string): boolean {
    return this.slots.has(sessionId);
  }

  /** True while the agent's lane has queued or running evaluations. */
  isAgentBusy(agentId: string): boolean {
    return this.lanes.has(toPrefixed(agentId));
  }

  // ── Triggers ───────────────────────────────────────────────────────────────

  /**
   * Ask for an evaluation. Returns immediately; `done` resolves when the
   * evaluation finished. Final triggers are persisted before returning.
   */
  trigger(req: TriggerRequest): TriggerHandle {
    const session = this.findSession(req);
    if (!session) return { status: 'unknown-session', done: resolved({ status: 'unknown-session' }) };
    const agent = this.agentForSession(session);
    const settings = agent ? this.settings.get(agent.agentId) : undefined;
    if (!agent || !settings || !agent.runtime) {
      return {
        status: 'not-configured', sessionId: session.id, ...(agent ? { agentId: agent.agentId } : {}),
        done: resolved({ status: 'not-configured', sessionId: session.id }),
      };
    }
    if (!settings.enabled) {
      return { status: 'disabled', sessionId: session.id, agentId: agent.agentId, done: resolved({ status: 'disabled', sessionId: session.id }) };
    }

    if (isFinalTrigger(req.reason)) this.store.markPending(session.id, req.reason, this.now().toISOString());
    this.memo.delete(session.id);

    const existing = this.slots.get(session.id);
    if (existing) {
      if (existing.running) existing.rerun = stronger(existing.rerun, req.reason);
      else existing.trigger = stronger(existing.trigger, req.reason);
      return { status: 'merged', sessionId: session.id, agentId: agent.agentId, done: existing.done };
    }
    return { status: 'queued', sessionId: session.id, agentId: agent.agentId, done: this.enqueue(session.id, agent.agentId, req.reason) };
  }

  /**
   * E68 S68.1 — ask for a consolidation pass for an agent. Shares the
   * agent's lane with session runs (one run per agent at a time). A
   * `scheduled` pass is skipped (status `nothing`) when no session journal
   * completed since the last pass; `manual` (/journal consolidate) always runs.
   */
  consolidate(agentId: string, reason: 'scheduled' | 'manual' = 'manual'): TriggerHandle {
    const id = toPrefixed(agentId);
    const settings = this.settings.get(id);
    const runtime = this.deps.resolver.resolve(id);
    if (!settings || !runtime) return { status: 'not-configured', agentId: id, done: resolved({ status: 'not-configured', agentId: id }) };
    if (!settings.enabled || !settings.consolidation.enabled) {
      return { status: 'disabled', agentId: id, done: resolved({ status: 'disabled', agentId: id }) };
    }
    const key = consolidationKey(id);
    const existing = this.slots.get(key);
    if (existing) {
      if (!existing.running) existing.trigger = stronger(existing.trigger, reason);
      return { status: 'merged', agentId: id, done: existing.done };
    }
    return { status: 'queued', agentId: id, done: this.enqueue(key, id, reason, 'consolidate') };
  }

  /** True while a consolidation pass is queued or running for the agent. */
  isConsolidating(agentId: string): boolean {
    return this.slots.has(consolidationKey(toPrefixed(agentId)));
  }

  private enqueue(sessionId: string, agentId: string, trigger: JournalTrigger, kind: Slot['kind'] = 'session'): Promise<EvaluationResult> {
    const slot: Slot = { kind, sessionId, agentId, trigger, running: false, rerun: null, done: Promise.resolve({ status: 'error' }) };
    this.slots.set(sessionId, slot);
    const previous = this.lanes.get(agentId) ?? Promise.resolve();
    const done = previous.then(async () => {
      slot.running = true;
      try {
        return kind === 'consolidate' ? await this.evaluateConsolidation(slot) : await this.evaluate(slot);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.log(`[journaling] evaluation failed for ${kind === 'consolidate' ? `consolidation of ${agentId}` : `session ${sessionId.slice(0, 8)}`}: ${error}`);
        return kind === 'consolidate' ? { status: 'error' as const, agentId, error } : { status: 'error' as const, sessionId, agentId, error };
      } finally {
        this.slots.delete(sessionId);
        if (slot.rerun && !this.stopped && kind === 'session') this.trigger({ reason: slot.rerun, sessionId });
      }
    });
    slot.done = done;
    const tail = done.then(() => undefined);
    this.lanes.set(agentId, tail);
    void tail.then(() => { if (this.lanes.get(agentId) === tail) this.lanes.delete(agentId); });
    return done;
  }

  /** `turn-ended`: re-anchor the session's pause clock. Never journals. */
  noteTurnEnded(sessionId: string, at?: string): void {
    this.store.noteTurnEnded(sessionId, at ?? this.now().toISOString());
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────

  private async evaluate(slot: Slot): Promise<EvaluationResult> {
    const session = this.findSession({ sessionId: slot.sessionId });
    if (!session) return { status: 'unknown-session', sessionId: slot.sessionId };
    const agent = this.agentForSession(session);
    const settings = agent ? this.settings.get(agent.agentId) : undefined;
    if (!agent?.runtime || !settings) return { status: 'not-configured', sessionId: session.id };
    const { agentId, runtime } = agent;
    const now = this.now();

    const cursorAt = session.journal_cursor_at ?? null;
    const window = loadWindow(this.deps.db, {
      sessionId: session.id,
      cursorAt,
      agentId,
      isOwner: this.deps.owners ? (contact, channel) => this.deps.owners!.isOwner(agentId, contact, channel) : undefined,
    });
    const state = this.store.getState(session.id);
    const pendingTrigger = (state?.pending_trigger as JournalTrigger | null) ?? null;
    const trigger: JournalTrigger = rank(slot.trigger) > 0 ? slot.trigger : (pendingTrigger ?? slot.trigger);
    const feedback = this.feedback.pendingForConversation(session.conversation_id);
    const eligibility = assessEligibility(window, {
      minHumanMessages: settings.minHumanMessages, trigger, hasPendingFinal: pendingTrigger !== null, now,
      feedback: feedback.some((f) => BYPASS_KINDS.has(f.kind)),
    });
    const base = { sessionId: session.id, agentId };

    if (eligibility.kind === 'nothing') {
      if (pendingTrigger) this.store.clearPending(session.id);
      this.memo.set(session.id, { lastActivity: session.last_activity, until: Number.POSITIVE_INFINITY });
      return { status: 'nothing', ...base };
    }
    if (eligibility.kind === 'pending') {
      this.memo.set(session.id, {
        lastActivity: session.last_activity, until: new Date(eligibility.firstHumanAt).getTime() + PENDING_MAX_AGE_MS,
      });
      return { status: 'pending', ...base };
    }
    if (trigger !== 'manual' && this.store.attemptsFor(session.id, window.advanceTo) >= MAX_ATTEMPTS_PER_WINDOW) {
      this.memo.set(session.id, { lastActivity: session.last_activity, until: Number.POSITIVE_INFINITY });
      return { status: 'attempt-cap', ...base };
    }

    const job = this.buildJob(session, agentId, runtime, settings, trigger, window);
    job.feedback = feedback.map(toFeedbackItem);
    const summary = await runChain(job, {
      chain: settings.chain,
      capabilities: runtime.capabilities,
      backlogSince: eligibleSince(window, { minHumanMessages: settings.minHumanMessages, pendingSince: state?.pending_since ?? null, now }),
    }, {
      store: this.store, registry: this.deps.registry, advisories: this.deps.advisories, now: this.deps.now, log: this.deps.log,
    });
    const status: EvaluationStatus =
      summary.outcome === 'done' ? 'journaled' : summary.outcome === 'nothing-to-do' ? 'nothing-to-do' : 'exhausted';
    if (summary.outcome !== 'exhausted') this.feedback.consume(feedback.map((f) => f.id), job.runId);
    const result: EvaluationResult = { status, ...base, summary };
    if (status === 'journaled' && this.deps.onJournaled) {
      try {
        this.deps.onJournaled(result);
      } catch (err) {
        this.log(`[journaling] onJournaled failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  /** E68 S68.1 — one consolidation pass through the agent's chain. */
  private async evaluateConsolidation(slot: Slot): Promise<EvaluationResult> {
    const agentId = slot.agentId;
    const settings = this.settings.get(agentId);
    const runtime = this.deps.resolver.resolve(agentId);
    if (!settings || !runtime) return { status: 'not-configured', agentId };
    const lastPassAt = this.store.lastConsolidation(agentId);
    const sessionRunsSince = this.store.sessionRunsSince(agentId, lastPassAt);
    if (slot.trigger !== 'manual' && sessionRunsSince === 0) {
      this.log(`[journaling] consolidation of ${agentId} skipped: no session journal since ${lastPassAt ?? 'ever'}`);
      return { status: 'nothing', agentId };
    }
    const job = this.buildConsolidationJob(agentId, runtime, settings, slot.trigger, lastPassAt, sessionRunsSince);
    const summary = await runChain(job, {
      chain: settings.chain, capabilities: runtime.capabilities, backlogSince: null,
    }, {
      store: this.store, registry: this.deps.registry, advisories: this.deps.advisories, now: this.deps.now, log: this.deps.log,
    });
    const status: EvaluationStatus =
      summary.outcome === 'done' ? 'journaled' : summary.outcome === 'nothing-to-do' ? 'nothing-to-do' : 'exhausted';
    const result: EvaluationResult = { status, agentId, summary };
    if (status === 'journaled' && this.deps.onJournaled) {
      try {
        this.deps.onJournaled(result);
      } catch (err) {
        this.log(`[journaling] onJournaled failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  private buildConsolidationJob(
    agentId: string,
    runtime: AgentRuntime,
    settings: JournalingSettings,
    trigger: JournalTrigger,
    lastPassAt: string | null,
    sessionRunsSince: number,
  ): JournalJob {
    const workingDir = runtimeWorkingDir(runtime);
    const layout = memoryLayout(memorySettingsFor(this.deps.config, agentId), workingDir);
    const now = this.now();
    const archiveBefore = formatLocalDate(new Date(now.getTime() - ARCHIVE_DAILIES_AFTER_DAYS * 86_400_000));
    const job: JournalJob = {
      runId: this.deps.newRunId?.() ?? randomUUID(),
      kind: 'consolidate',
      trigger,
      agentId,
      sessionAgentId: agentId,
      runtime: runtime.kind,
      workingDir,
      memoryDir: layout.memoryDir,
      nativeMemory: usesNativeMemory(layout, runtime.capabilities),
      sessionId: '',
      conversationId: '',
      channel: '',
      contactId: '',
      topic: null,
      claudeSessionId: null,
      harnessSessionId: null,
      harnessTranscriptPath: null,
      sessionOpen: false,
      window: { cursorAt: lastPassAt, from: lastPassAt, to: now.toISOString(), advanceTo: null },
      messages: [],
      humanMessageCount: 0,
      snapshots: [],
      prompt: settings.consolidation.prompt,
      model: settings.model,
      timeoutMs: settings.consolidation.timeoutMs,
      settings,
      consolidation: {
        lastPassAt,
        sessionRunsSince,
        indexPath: layout.indexPath,
        dailyDir: layout.dailyDir,
        archiveDir: layout.archiveDir,
        archiveBefore,
        maxMemoryLines: settings.consolidation.maxMemoryLines,
        maxMemoryBytes: NATIVE_MEMORY_MAX_BYTES,
        feedback: this.feedback.summary(agentId, lastPassAt),
      },
    };
    job.prompt = consolidationPrompt(settings.consolidation.prompt, job);
    return job;
  }

  private buildJob(
    session: SessionRow,
    agentId: string,
    runtime: AgentRuntime,
    settings: JournalingSettings,
    trigger: JournalTrigger,
    window: ReturnType<typeof loadWindow>,
  ): JournalJob {
    const state = this.store.getState(session.id);
    const topic = (this.deps.db.prepare('SELECT topic FROM conversation_registry WHERE id = ?').get(session.conversation_id) as
      | { topic: string } | undefined)?.topic ?? null;
    const workingDir = runtimeWorkingDir(runtime);
    const layout = memoryLayout(memorySettingsFor(this.deps.config, agentId), workingDir);
    return {
      runId: this.deps.newRunId?.() ?? randomUUID(),
      kind: 'session',
      trigger,
      agentId,
      sessionAgentId: session.agent_id ?? agentId,
      runtime: runtime.kind,
      workingDir,
      memoryDir: layout.memoryDir,
      nativeMemory: usesNativeMemory(layout, runtime.capabilities),
      sessionId: session.id,
      conversationId: session.conversation_id,
      channel: session.channel,
      contactId: session.contact_id,
      topic,
      claudeSessionId: session.claude_session_id,
      harnessSessionId: state?.harness_session_id ?? null,
      harnessTranscriptPath: state?.harness_transcript_path ?? null,
      sessionOpen: session.ended_at === null,
      window: { cursorAt: window.cursorAt, from: window.from, to: window.to, advanceTo: window.advanceTo },
      messages: window.messages,
      humanMessageCount: window.humanTimes.length,
      snapshots: this.store.pendingSnapshots(session.id).map((s) => ({ id: s.id, event: s.event, path: s.path, created_at: s.created_at })),
      prompt: settings.prompt,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      settings,
    };
  }

  // ── Tick: pause, ceiling, pending finals, retention ───────────────────────

  start(): void {
    this.stopped = false;
    this.tick();
    const interval = this.deps.tickIntervalMs ?? this.deps.config.memory?.summarizer_interval_ms ?? 60_000;
    this.timer = setInterval(() => this.tick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep. Exposed for tests. Never throws. */
  tick(): void {
    const step = (name: string, fn: () => void) => {
      try { fn(); } catch (err) { this.log(`[journaling] tick ${name} failed: ${err instanceof Error ? err.message : String(err)}`); }
    };
    step('pending', () => this.tickPending());
    step('timers', () => this.tickTimers());
    step('retention', () => this.tickRetention());
    for (const fn of this.tickers) step('ticker', fn);
  }

  /** Re-evaluate persisted final triggers (e.g. after a restart). */
  private tickPending(): void {
    for (const row of this.store.listPending()) {
      if (this.slots.has(row.session_id)) continue;
      this.trigger({ reason: row.pending_trigger as JournalTrigger, sessionId: row.session_id });
    }
  }

  private tickTimers(): void {
    const now = this.now().getTime();
    const rows = this.deps.db
      .prepare(
        `SELECT s.*, js.last_turn_ended_at AS js_turn_ended,
                (SELECT MAX(t.created_at) FROM transcripts t WHERE t.session_id = s.id AND t.direction = 'outbound') AS last_outbound,
                (SELECT MAX(f.created_at) FROM feedback_events f
                   WHERE f.conversation_id = s.conversation_id AND f.consumed_at IS NULL
                     AND f.kind IN ('denied-approval', 'user-feedback')) AS last_feedback
         FROM sessions s LEFT JOIN journal_state js ON js.session_id = s.id
         WHERE s.ended_at IS NULL AND (s.journal_cursor_at IS NULL OR s.journal_cursor_at < s.last_activity
           OR EXISTS (SELECT 1 FROM feedback_events f WHERE f.conversation_id = s.conversation_id AND f.consumed_at IS NULL
                        AND f.kind IN ('denied-approval', 'user-feedback')))`,
      )
      .all() as Array<SessionRow & { js_turn_ended: string | null; last_outbound: string | null; last_feedback: string | null }>;

    for (const s of rows) {
      if (this.slots.has(s.id)) continue;
      const memo = this.memo.get(s.id);
      if (memo && memo.lastActivity === s.last_activity && now < memo.until) continue;
      const agent = this.agentForSession(s);
      const settings = agent ? this.settings.get(agent.agentId) : undefined;
      if (!agent?.runtime || !settings?.enabled) continue;

      const anchor = Math.max(
        new Date(s.last_activity).getTime(),
        s.js_turn_ended ? new Date(s.js_turn_ended).getTime() : 0,
        s.last_outbound ? new Date(s.last_outbound).getTime() : 0,
        // E68: feedback re-anchors the pause clock like activity, so /feedback
        // rides with the next journal instead of starting one at once.
        s.last_feedback ? new Date(s.last_feedback).getTime() : 0,
      );
      if (now - anchor >= thresholdForChannel(settings.thresholdMs, s.channel)) {
        this.trigger({ reason: 'pause', sessionId: s.id });
        continue;
      }
      const since = new Date(s.last_journaled_at ?? s.started_at).getTime();
      if (settings.ceilingMs !== null && now - since >= settings.ceilingMs) {
        this.trigger({ reason: 'ceiling', sessionId: s.id });
      }
    }
  }

  private tickRetention(): void {
    const now = this.now().getTime();
    if (now - this.lastRetentionSweep < RETENTION_SWEEP_EVERY_MS) return;
    this.lastRetentionSweep = now;
    const swept = this.store.sweepRuns();
    if (swept > 0) this.log(`[journaling] swept ${swept} journal_runs row(s) older than 90 days`);
    const sweptFeedback = this.feedback.sweep();
    if (sweptFeedback > 0) this.log(`[journaling] swept ${sweptFeedback} feedback event(s) older than 90 days`);
  }

  // ── Shutdown ───────────────────────────────────────────────────────────────

  /**
   * Bus shutdown: stop ticking, persist a `shutdown` trigger for every open
   * session with unjournaled human content (journaled after restart,
   * bypassing min_human_messages), then wait up to `waitMs` for runs already
   * in flight. Returns the sessions marked.
   */
  async shutdown(opts: { waitMs?: number } = {}): Promise<string[]> {
    this.stop();
    const marked: string[] = [];
    try {
      const open = this.deps.db
        .prepare(`SELECT * FROM sessions WHERE ended_at IS NULL AND (journal_cursor_at IS NULL OR journal_cursor_at < last_activity)`)
        .all() as SessionRow[];
      for (const s of open) {
        const agent = this.agentForSession(s);
        const settings = agent ? this.settings.get(agent.agentId) : undefined;
        if (!agent?.runtime || !settings?.enabled) continue;
        const window = loadWindow(this.deps.db, { sessionId: s.id, cursorAt: s.journal_cursor_at ?? null, agentId: agent.agentId });
        if (window.humanTimes.length === 0) continue;
        this.store.markPending(s.id, 'shutdown', this.now().toISOString());
        marked.push(s.id);
      }
    } catch (err) {
      this.log(`[journaling] shutdown bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const inflight = [...this.slots.values()].map((s) => s.done);
    if (inflight.length > 0) {
      const waitMs = opts.waitMs ?? DEFAULT_SHUTDOWN_WAIT_MS;
      await Promise.race([
        Promise.allSettled(inflight),
        new Promise<void>((r) => { const t = setTimeout(r, waitMs); t.unref?.(); }),
      ]);
    }
    return marked;
  }
}
