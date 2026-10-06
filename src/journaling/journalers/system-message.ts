/**
 * System Message journaler (E66 S66.8): ask the live agent to journal, in
 * a bus-originated system block (E65 `renderSystemBlock`, kind "journal"),
 * and wait for it to call the `journal_complete` MCP tool.
 *
 * While a run is open the conversation belongs to the run:
 *   - new messages for it are **held** in the queue (the pending poll skips
 *     them) and delivered when the run ends;
 *   - the sender gets **one busy notice per hold**, through the channel's
 *     native queued or status signal where it has one (app activity,
 *     Telegram status line), a short text elsewhere, nothing on email.
 *     The wording never mentions journaling;
 *   - **every outbound send from the agent is refused** with 409 (POST
 *     /api/v1/messages), except `journal_complete` and `advisory_ack`, which
 *     use their own endpoints.
 *
 * `canJournal` needs `systemMessages`, a live, exclusive session right now
 * (the pane still leased to the conversation), an open session, no other
 * run for the agent, and an idle agent: nothing queued for it, and its last
 * turn finished (the `turn-ended` hook when it reports, else the agent's
 * last message coming after the last human one).
 *
 * Outcomes: `journal_complete` → `done` (or `nothing-to-do` with
 * `nothing_new: true`); timeout (`system-message.timeout_ms`, default the
 * journaling timeout) → `failed-after-start`; instruction not delivered →
 * `failed-before-start`. A memory-dir diff runs independently of what the
 * agent reports and is merged into `files_changed`.
 *
 * Agent jobs (no conversation, E68 consolidation) go to the agent's
 * default conversation: its first owner's `general` conversation.
 */
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import type { MessageEnvelope } from '../../types/envelope.js';
import { JOURNAL_RUN_KEY, renderSystemBlock } from '../../core/system-block.js';
import type { OwnerDirectory } from '../../core/owners.js';
import type { PoolLeaseLookup, RuntimeResolver } from '../../core/runtime-resolver.js';
import { diffMemory, snapshotMemoryDir } from '../memory-diff.js';
import { jobContextLines } from '../prompt.js';
import type { Journaler, JournalAvailability, JournalJob, JournalRunContext, JournalRunResult } from '../types.js';

export { JOURNAL_RUN_KEY };
/** System-block kind of a journaling instruction. */
export const JOURNAL_BLOCK_KIND = 'journal';
/** Text of the busy notice. Generic on purpose: it never says why. */
export const BUSY_NOTICE_TEXT = 'Busy for a moment. Your message is queued and will be answered shortly.';

const AGENT_PREFIX = 'agent:';
const toPrefixed = (id: string) => (id.startsWith(AGENT_PREFIX) ? id : `${AGENT_PREFIX}${id}`);

/** Where a run's instruction goes and whose conversation it holds. */
export interface RunTarget {
  conversationId: string;
  channel: string;
  contactId: string;
  topic: string;
}

export interface ActiveSystemRun extends RunTarget {
  runId: string;
  /** Logical agent id (a pool's id). */
  agentId: string;
  /** Prefixed id the agent receives and sends as (a pane id for cc-pool). */
  recipient: string;
  startedAt: string;
  noticeSent: boolean;
}

export interface CompletionInput {
  runId: string;
  /** The caller, bare or prefixed (a pane id for cc-pool). */
  agentId: string;
  filesChanged?: string[];
  notes?: string;
  nothingNew?: boolean;
}

export type CompletionResult =
  | { ok: true; runId: string }
  | { ok: false; reason: 'unknown_run' | 'stale_run' | 'wrong_agent' | 'already_completed' };

interface Completion { filesChanged: string[]; notes: string | null; nothingNew: boolean }

interface Entry {
  run: ActiveSystemRun;
  completed: boolean;
  resolve: (c: Completion) => void;
}

/** Ended run ids kept to tell a stale `journal_complete` from an unknown one. */
const ENDED_MEMORY = 200;

/**
 * In-process state of open System Message runs: holds, outbound blocks and
 * completions. One per bus. Not persisted: after a restart nothing is held
 * and a late `journal_complete` is rejected as unknown.
 */
export class JournalRunGate {
  private readonly byRun = new Map<string, Entry>();
  private readonly ended: string[] = [];
  private listeners: Array<(run: ActiveSystemRun, event: 'start' | 'end') => void> = [];

  /** Open a run. Resolves when `journal_complete` arrives for it. */
  start(run: Omit<ActiveSystemRun, 'noticeSent'>): Promise<Completion> {
    return new Promise((resolve) => {
      const entry: Entry = { run: { ...run, noticeSent: false }, completed: false, resolve };
      this.byRun.set(run.runId, entry);
      this.emit(entry.run, 'start');
    });
  }

  /** Close a run (completed, timed out or aborted). Held messages flow again. */
  end(runId: string): ActiveSystemRun | null {
    const entry = this.byRun.get(runId);
    if (!entry) return null;
    this.byRun.delete(runId);
    this.ended.push(runId);
    if (this.ended.length > ENDED_MEMORY) this.ended.shift();
    this.emit(entry.run, 'end');
    return entry.run;
  }

  onChange(listener: (run: ActiveSystemRun, event: 'start' | 'end') => void): void {
    this.listeners.push(listener);
  }

  private emit(run: ActiveSystemRun, event: 'start' | 'end'): void {
    for (const l of this.listeners) {
      try { l(run, event); } catch (err) { console.error('[journaling] run gate listener failed:', err); }
    }
  }

  active(): ActiveSystemRun[] {
    return [...this.byRun.values()].map((e) => e.run);
  }

  get(runId: string): ActiveSystemRun | null {
    return this.byRun.get(runId)?.run ?? null;
  }

  /** The open run holding `conversationId`, if any. */
  runForConversation(conversationId: string | null | undefined): ActiveSystemRun | null {
    if (!conversationId) return null;
    for (const { run } of this.byRun.values()) if (run.conversationId === conversationId) return run;
    return null;
  }

  /** The open run for an agent (logical id), if any. */
  runForAgent(agentId: string): ActiveSystemRun | null {
    const id = toPrefixed(agentId);
    for (const { run } of this.byRun.values()) if (run.agentId === id) return run;
    return null;
  }

  /**
   * True when a queued envelope must wait: it is addressed to the agent of an
   * open run, belongs to that run's conversation (or carries none, e.g. a
   * pane's own queue), and is not the run's own instruction.
   */
  isHeld(envelope: Pick<MessageEnvelope, 'recipient' | 'metadata'>): boolean {
    if (this.byRun.size === 0) return false;
    const conversationId = typeof envelope.metadata?.['conversation_id'] === 'string' ? envelope.metadata['conversation_id'] : null;
    for (const { run } of this.byRun.values()) {
      if (envelope.recipient !== run.recipient) continue;
      if (conversationId && conversationId !== run.conversationId) continue;
      if (envelope.metadata?.[JOURNAL_RUN_KEY] === run.runId) continue;
      return true;
    }
    return false;
  }

  /** The open run whose agent `sender` is, when that agent may not send right now. */
  blockedSend(sender: string): ActiveSystemRun | null {
    const id = toPrefixed(sender);
    for (const { run } of this.byRun.values()) if (run.recipient === id || run.agentId === id) return run;
    return null;
  }

  /** First held message of a run: returns the run once, so its busy notice is sent once per hold. */
  claimNotice(conversationId: string | null | undefined): ActiveSystemRun | null {
    const run = this.runForConversation(conversationId);
    if (!run || run.noticeSent) return null;
    run.noticeSent = true;
    return run;
  }

  /** `journal_complete`. A run id that is not open is stale (ended) or unknown. */
  complete(input: CompletionInput, logicalAgentId: (id: string) => string = (id) => toPrefixed(id)): CompletionResult {
    const entry = this.byRun.get(input.runId);
    if (!entry) return { ok: false, reason: this.ended.includes(input.runId) ? 'stale_run' : 'unknown_run' };
    const caller = toPrefixed(input.agentId);
    if (caller !== entry.run.recipient && logicalAgentId(caller) !== entry.run.agentId) return { ok: false, reason: 'wrong_agent' };
    if (entry.completed) return { ok: false, reason: 'already_completed' };
    entry.completed = true;
    entry.resolve({
      filesChanged: (input.filesChanged ?? []).filter((f) => typeof f === 'string').slice(0, 200),
      notes: typeof input.notes === 'string' ? input.notes.slice(0, 2000) : null,
      nothingNew: input.nothingNew === true,
    });
    return { ok: true, runId: input.runId };
  }
}

/** Delivers a journaling instruction as a system-only turn (bus wiring: `createJournalInstructionDelivery`). */
export type InstructionDelivery = (req: {
  runId: string;
  agentId: string;
  target: RunTarget;
  block: string;
}) => Promise<{ queued: boolean; messageId?: string; conversationId?: string | null; reason?: string }>;

export interface SystemMessageJournalerDeps {
  db: Database.Database;
  resolver: Pick<RuntimeResolver, 'checkLive' | 'resolve'>;
  gate: JournalRunGate;
  deliver: InstructionDelivery;
  owners?: Pick<OwnerDirectory, 'ownerConversations'>;
  /** Keyed by the pool's prefixed agent id; finds the pane currently leased to a conversation. */
  poolManagers?: Map<string, PoolLeaseLookup & { leaseStore: { findByConversation(poolId: string, conversationId: string): { agent_id: string; state: string; last_turn_ended_at?: string | null } | null } }>;
  /** Called when a run times out with its instruction still queued (dead-letter it). */
  withdraw?: (messageId: string, reason: string) => void;
  now?: () => Date;
}

export class SystemMessageJournaler implements Journaler {
  readonly id = 'system-message' as const;
  readonly requires = ['systemMessages', 'liveAgent', 'exclusiveSession'] as const;
  readonly supportsKinds = ['session', 'consolidate'] as const;

  constructor(private readonly deps: SystemMessageJournalerDeps) {}

  /** The run's conversation: the job's, or for agent jobs the agent's default conversation. */
  target(job: JournalJob): RunTarget | null {
    if (job.conversationId) {
      return { conversationId: job.conversationId, channel: job.channel, contactId: job.contactId, topic: job.topic ?? 'general' };
    }
    const owner = this.deps.owners?.ownerConversations(job.agentId)[0];
    return owner ? { conversationId: owner.conversationId, channel: owner.channel, contactId: owner.contactId, topic: owner.topic } : null;
  }

  /** The id the agent currently receives this conversation's messages as (the leased pane for cc-pool). */
  recipient(job: JournalJob, conversationId: string): string {
    const runtime = this.deps.resolver.resolve(job.agentId);
    if (runtime?.kind === 'cc-pool') {
      const manager = this.deps.poolManagers?.get(runtime.poolAgentId);
      const lease = manager?.leaseStore.findByConversation(manager.poolId, conversationId);
      if (lease) return lease.agent_id;
    }
    return job.kind === 'session' ? toPrefixed(job.sessionAgentId) : toPrefixed(job.agentId);
  }

  canJournal(job: JournalJob): JournalAvailability {
    const runtime = this.deps.resolver.resolve(job.agentId);
    if (!runtime?.capabilities.systemMessages) return { ok: false, reason: `${runtime?.kind ?? 'no runtime'} can't take system messages` };
    if (job.kind === 'session' && !job.sessionOpen) return { ok: false, reason: 'session is closed; its live context is gone' };
    const target = this.target(job);
    if (!target) return { ok: false, reason: 'agent has no default conversation (configure an owner)' };
    for (const cap of ['liveAgent', 'exclusiveSession'] as const) {
      const live = this.deps.resolver.checkLive(cap, { agentId: job.agentId, conversationId: target.conversationId });
      if (!live.ok) return { ok: false, reason: `${cap}: ${live.reason}` };
    }
    const other = this.deps.gate.runForAgent(job.agentId);
    if (other) return { ok: false, reason: `run ${other.runId} is already open for ${job.agentId}` };
    const busy = this.busyReason(job, target);
    return busy ? { ok: false, reason: busy } : { ok: true };
  }

  /** Why the agent is not idle in `target`, or null. */
  private busyReason(job: JournalJob, target: RunTarget): string | null {
    const recipient = this.recipient(job, target.conversationId);
    const queued = this.deps.db
      .prepare(`SELECT COUNT(*) AS n FROM message_queue WHERE recipient = ? AND status IN ('pending', 'processing')`)
      .get(recipient) as { n: number };
    if (queued.n > 0) return `agent has ${queued.n} message(s) waiting or in progress`;

    const lastHuman = (this.deps.db
      .prepare(
        `SELECT MAX(created_at) AS at FROM transcripts
         WHERE conversation_id = ? AND direction = 'inbound'
           AND contact_id NOT LIKE 'agent:%' AND contact_id NOT LIKE 'system:%'
           AND body NOT LIKE '/%' AND body NOT LIKE '[reaction:%'
           AND COALESCE(json_extract(metadata, '$.system_only'), 0) = 0`,
      )
      .get(target.conversationId) as { at: string | null }).at;
    if (!lastHuman) return null;

    const turnEnded = this.lastTurnEnded(job, target.conversationId, recipient);
    if (turnEnded !== null) {
      return turnEnded >= lastHuman ? null : 'agent is still answering (no turn-ended since the last message)';
    }
    const lastOut = (this.deps.db
      .prepare(`SELECT MAX(created_at) AS at FROM transcripts WHERE conversation_id = ? AND direction = 'outbound'
        AND json_extract(metadata, '$.command_response') IS NOT 1`)
      .get(target.conversationId) as { at: string | null }).at;
    return lastOut && lastOut >= lastHuman ? null : 'agent has not answered the last message yet';
  }

  /** Latest turn-ended seen for the conversation (journal hook or pool Stop hook), or null when none ever reported. */
  private lastTurnEnded(job: JournalJob, conversationId: string, recipient: string): string | null {
    const times: string[] = [];
    if (job.kind === 'session') {
      const row = this.deps.db.prepare('SELECT last_turn_ended_at FROM journal_state WHERE session_id = ?').get(job.sessionId) as
        | { last_turn_ended_at: string | null } | undefined;
      if (row?.last_turn_ended_at) times.push(row.last_turn_ended_at);
    }
    const runtime = this.deps.resolver.resolve(job.agentId);
    if (runtime?.kind === 'cc-pool') {
      const manager = this.deps.poolManagers?.get(runtime.poolAgentId);
      const lease = manager?.leaseStore.findByConversation(manager.poolId, conversationId);
      if (lease && lease.agent_id === recipient && lease.last_turn_ended_at) times.push(lease.last_turn_ended_at);
    }
    return times.length > 0 ? times.sort()[times.length - 1]! : null;
  }

  instructionText(job: JournalJob, timeoutMs: number): string {
    const settings = job.settings.journalers['system-message'];
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
    const lines = [
      `AgentBus journal run ${job.runId} (${job.kind === 'consolidate' ? 'consolidation' : `trigger: ${job.trigger}`}).`,
      '',
      job.kind === 'consolidate' ? job.prompt : settings.prompt,
      '',
      ...(job.kind === 'session' ? [...jobContextLines(job), ''] : []),
      'Until this run ends, new messages to you are held and your outbound messages are blocked, so do not reply to anyone.',
      `When you are done, call the journal_complete tool with run_id "${job.runId}", the files you changed and a one-line note. ` +
        'If nothing was worth recording, call it with nothing_new: true.',
      `The run times out after ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    ];
    return lines.join('\n');
  }

  async run(job: JournalJob, ctx?: JournalRunContext): Promise<JournalRunResult> {
    const target = this.target(job);
    if (!target) return { outcome: 'unavailable', error: 'agent has no default conversation' };
    const timeoutMs = job.settings.journalers['system-message'].timeoutMs;
    const recipient = this.recipient(job, target.conversationId);
    const before = snapshotMemoryDir(job.memoryDir);
    const now = this.deps.now?.() ?? new Date();

    const completion = this.deps.gate.start({
      runId: job.runId, agentId: toPrefixed(job.agentId), recipient, startedAt: now.toISOString(), ...target,
    });

    let messageId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    try {
      const block = renderSystemBlock(JOURNAL_BLOCK_KIND, this.instructionText(job, timeoutMs), { run_id: job.runId });
      let delivered;
      try {
        delivered = await this.deps.deliver({ runId: job.runId, agentId: toPrefixed(job.agentId), target, block });
      } catch (err) {
        return { outcome: 'failed-before-start', error: `instruction not delivered: ${err instanceof Error ? err.message : String(err)}` };
      }
      messageId = delivered.messageId;
      if (!delivered.queued) return { outcome: 'failed-before-start', error: `instruction not delivered: ${delivered.reason ?? 'not queued'}` };
      if (delivered.conversationId && delivered.conversationId !== target.conversationId) {
        if (messageId) this.deps.withdraw?.(messageId, 'journal instruction routed to the wrong conversation');
        return { outcome: 'failed-before-start', error: `instruction routed to conversation ${delivered.conversationId.slice(0, 8)}, not ${target.conversationId.slice(0, 8)}` };
      }

      const outcome = await new Promise<Completion | 'timeout' | 'aborted'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref?.();
        onAbort = () => resolve('aborted');
        if (ctx?.signal.aborted) resolve('aborted');
        else ctx?.signal.addEventListener('abort', onAbort, { once: true });
        void completion.then(resolve);
      });

      const diffed = diffMemory(before, snapshotMemoryDir(job.memoryDir)).map((p) =>
        job.workingDir && job.memoryDir ? relative(job.workingDir, join(job.memoryDir, p)) : p);

      if (outcome === 'timeout' || outcome === 'aborted') {
        if (messageId) this.deps.withdraw?.(messageId, `journal run ${job.runId} ${outcome === 'timeout' ? 'timed out' : 'was aborted'}`);
        return {
          outcome: 'failed-after-start', fidelity: 'full-session',
          error: outcome === 'timeout' ? `no journal_complete within ${timeoutMs} ms` : 'run aborted before journal_complete',
          ...(diffed.length > 0 ? { filesChanged: diffed } : {}),
        };
      }
      const files = [...new Set([...outcome.filesChanged, ...diffed])].sort();
      return {
        outcome: outcome.nothingNew && files.length === 0 ? 'nothing-to-do' : 'done',
        fidelity: 'full-session',
        ...(files.length > 0 ? { filesChanged: files } : {}),
        ...(outcome.notes ? { notes: outcome.notes } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) ctx?.signal.removeEventListener('abort', onAbort);
      this.deps.gate.end(job.runId);
    }
  }
}
