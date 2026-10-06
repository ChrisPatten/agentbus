/**
 * Journaling types shared by the store, the engine, the chain runner and
 * the journalers (E66). See docs/JOURNALING.md.
 */
import type { RequiredCapability, RuntimeKind } from '../core/runtime-capabilities.js';
import type { JournalerId } from '../config/schema.js';
import type { JournalingSettings } from './config.js';
import type { FeedbackItem, FeedbackSummary } from './feedback.js';

export type { JournalerId };

/**
 * What a journaler reports for one attempt.
 *   done                 memory updated
 *   nothing-to-do        ran, found nothing worth recording
 *   unavailable          could not run right now; nothing was attempted
 *   failed-before-start  tried to start and failed before touching anything
 *   failed-after-start   started and failed (or timed out); partial writes are possible
 * The cursor advances only on done / nothing-to-do; every other outcome
 * moves the chain to the next journaler.
 */
export const JOURNAL_OUTCOMES = ['done', 'nothing-to-do', 'unavailable', 'failed-before-start', 'failed-after-start'] as const;
export type JournalOutcome = (typeof JOURNAL_OUTCOMES)[number];

/** Outcomes that end the chain successfully and advance the cursor. */
export const isSuccess = (o: JournalOutcome): o is 'done' | 'nothing-to-do' => o === 'done' || o === 'nothing-to-do';

/** What the journaler could see: only the bus transcript, a harness snapshot, or the full live/resumed session. */
export type JournalFidelity = 'bus-transcript' | 'snapshot' | 'full-session';

/** Session jobs journal one conversation window; consolidation jobs (E68) work on the memory dir. */
export type JobKind = 'session' | 'consolidate';

/**
 * Why an evaluation happened. A trigger means "evaluate", never "journal now".
 *   pause, ceiling          bus-side timers (tick)
 *   close, clear, evict,    final: the session's context is about to go away.
 *   release, shutdown,      They bypass min_human_messages.
 *   pre-compact, session-end
 *   manual                  /journal now: bypasses the pause threshold and
 *                           min_human_messages, respects the cursor;
 *                           /journal consolidate
 *   scheduled               consolidation's own cron (E68)
 */
export const JOURNAL_TRIGGERS = [
  'pause', 'ceiling', 'close', 'clear', 'evict', 'release', 'shutdown', 'pre-compact', 'session-end', 'manual',
  // E68 — consolidation's cron (manual consolidation uses `manual`).
  'scheduled',
] as const;
export type JournalTrigger = (typeof JOURNAL_TRIGGERS)[number];

export const FINAL_TRIGGERS: ReadonlySet<JournalTrigger> = new Set<JournalTrigger>([
  'close', 'clear', 'evict', 'release', 'shutdown', 'pre-compact', 'session-end',
]);

export const isFinalTrigger = (t: JournalTrigger): boolean => FINAL_TRIGGERS.has(t);

/** One message in a journal window, as journalers receive it. */
export interface JournalMessage {
  /** transcripts.id */
  id: string;
  /** Bus message id. */
  message_id: string;
  created_at: string;
  direction: 'inbound' | 'outbound';
  author: {
    /** Contact id (bare) for inbound; the agent id for outbound. */
    id: string;
    is_human: boolean;
    is_owner: boolean;
    is_agent: boolean;
  };
  body: string;
  attachments: Array<{ type: string; path: string; mime_type?: string; filename?: string }>;
  /** Scheduler-fired inbound (`metadata.scheduled`). */
  scheduled: boolean;
  /** True for messages before the first eligible human message, included only as context. */
  context: boolean;
}

export interface JournalSnapshot {
  id: string;
  event: string;
  path: string;
  created_at: string;
}

/**
 * E68 S68.1 — what a consolidation job works on: the agent's memory files
 * and the journal runs since the last pass. Set on `consolidate` jobs only.
 */
export interface ConsolidationContext {
  /** When the last successful consolidation started (null: never). */
  lastPassAt: string | null;
  /** Session journal runs that ended `done` since the last pass. */
  sessionRunsSince: number;
  indexPath: string | null;
  dailyDir: string | null;
  archiveDir: string | null;
  /** Local date `YYYY-MM-DD`: dailies older than this may be archived once promoted (30 days). */
  archiveBefore: string;
  /** MEMORY.md budget: native auto memory loads the first 200 lines / 25 KB. */
  maxMemoryLines: number;
  maxMemoryBytes: number;
  /** E68 S68.2 — feedback events across conversations since the last pass. */
  feedback?: FeedbackSummary;
}

/**
 * Everything a journaler needs for one attempt. Built by the engine once per
 * run; each journaler in the chain receives the same job (with its own
 * `journaler` settings looked up from `settings`).
 */
export interface JournalJob {
  runId: string;
  kind: JobKind;
  trigger: JournalTrigger;
  /** Prefixed logical agent id (a pool's id). */
  agentId: string;
  /** The id the session is attributed to: a pane id for cc-pool, else = agentId. */
  sessionAgentId: string;
  runtime: RuntimeKind;
  workingDir: string | null;
  /** Absolute memory dir from the agent's memory layout (E67, `agents.<id>.memory.dir`); null without one. */
  memoryDir: string | null;
  /**
   * E67 — the agent loads memory natively (layout `native` and the runtime's
   * `nativeMemory`). Journalers that start `claude` point auto memory at
   * `memoryDir` (`--settings`) and drop `CLAUDE_CODE_DISABLE_AUTO_MEMORY`.
   */
  nativeMemory?: boolean;
  sessionId: string;
  conversationId: string;
  channel: string;
  contactId: string;
  topic: string | null;
  /** Claude session id the bus knows for this session (cc-headless / cc-pool). */
  claudeSessionId: string | null;
  /** The harness's own session id, when a hook reported one. */
  harnessSessionId: string | null;
  harnessTranscriptPath: string | null;
  /** Whether the session is still open (false after close or /clear). */
  sessionOpen: boolean;
  window: {
    /** Cursor before this run (null: never journaled). */
    cursorAt: string | null;
    /** created_at of the first message in `messages` (context included). */
    from: string | null;
    /** created_at of the last message in `messages`. */
    to: string | null;
    /** Where the cursor moves on success: the newest transcript row past the cursor. */
    advanceTo: string | null;
  };
  messages: JournalMessage[];
  humanMessageCount: number;
  snapshots: JournalSnapshot[];
  /**
   * E68 S68.2 — feedback events of the conversation not yet journaled
   * (denied approvals, `/feedback`, tool errors), oldest first. Consumed
   * when the run succeeds. Session jobs only.
   */
  feedback?: FeedbackItem[];
  /** Journaling instruction (journaling-level; journalers may override from their own settings). */
  prompt: string;
  model: string | null;
  timeoutMs: number;
  /** The agent's effective journaling settings; per-journaler settings live under `settings.journalers`. */
  settings: JournalingSettings;
  /** E68 — set on `consolidate` jobs. Session fields (session/conversation/channel/contact) are empty strings there. */
  consolidation?: ConsolidationContext;
  /**
   * E68 S68.4 — the agent's protected paths, absolute; directories end in
   * `/`. Journalers that start `claude` deny edits to them; the chain runner
   * hashes them before and after the run.
   */
  protectedPaths?: string[];
}

/** Result of `Journaler.canJournal`: cheap, side-effect free. */
export type JournalAvailability = { ok: true } | { ok: false; reason: string };

/** Result of `Journaler.run`. */
export interface JournalRunResult {
  outcome: JournalOutcome;
  error?: string;
  fidelity?: JournalFidelity;
  filesChanged?: string[];
  notes?: string;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * Per-attempt context from the chain runner. `signal` aborts when the
 * runner's settle timeout (a multiple of the job timeout) fires: a
 * journaler must then stop its work (kill its process group, release its
 * holds) and settle promptly.
 */
export interface JournalRunContext {
  signal: AbortSignal;
}

/**
 * A journaler: one way to carry out a journal run. Register instances with
 * `JournalerRegistry`. `requires` is checked statically (config load and
 * before each attempt); `canJournal` covers live state (pane still leased,
 * transcript still on disk, agent idle).
 */
export interface Journaler {
  readonly id: JournalerId;
  readonly requires: readonly RequiredCapability[];
  readonly supportsKinds: readonly JobKind[];
  canJournal(job: JournalJob): JournalAvailability | Promise<JournalAvailability>;
  /** Must not throw for expected failures; a throw is recorded as `failed-after-start`. */
  run(job: JournalJob, ctx?: JournalRunContext): Promise<JournalRunResult>;
}
