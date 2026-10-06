/**
 * PROVISIONAL cc-headless journaler (E66 part A). Wraps the existing
 * headless journaling turn (`HeadlessHandle.journalSession`, the
 * generalized `runJournalingTurn`) so today's headless journaling keeps
 * working through the new engine and chain runner until S66.6 replaces it.
 *
 * Limitations S66.6 removes:
 *   - Only sessions of `cc-headless` instances (it needs that instance's
 *     handle). cc-pool sessions report `unavailable`; S66.6 runs
 *     `claude -p --resume <claude_session_id>` for them too.
 *   - The journaler `model` setting is ignored: the turn uses the
 *     instance's own model resolution, as before E66.
 *   - The prompt is the per-journaler prompt from settings, with no job
 *     payload (window, snapshots) added: the resumed session already holds
 *     the conversation.
 */
import type { JournalSessionRequest, JournalSessionResult } from '../../adapters/cc-headless.js';
import type { RuntimeResolver } from '../../core/runtime-resolver.js';
import type { Journaler, JournalAvailability, JournalJob, JournalRunResult } from '../types.js';

export interface HeadlessJournalHandle {
  journalSession(opts: JournalSessionRequest): Promise<JournalSessionResult>;
}

export class ProvisionalHeadlessJournaler implements Journaler {
  readonly id = 'cc-headless' as const;
  readonly requires = ['sessionResume'] as const;
  readonly supportsKinds = ['session'] as const;

  /** Keyed by prefixed agent id, as `startHeadless()` returns them. */
  private readonly handles = new Map<string, HeadlessJournalHandle>();

  constructor(private readonly resolver: Pick<RuntimeResolver, 'checkLive'>) {}

  addHandle(agentId: string, handle: HeadlessJournalHandle): void {
    this.handles.set(agentId, handle);
  }

  canJournal(job: JournalJob): JournalAvailability {
    if (job.runtime !== 'cc-headless') {
      return { ok: false, reason: `provisional cc-headless journaler only runs cc-headless sessions (not ${job.runtime})` };
    }
    if (!this.handles.has(job.agentId)) return { ok: false, reason: `cc-headless instance ${job.agentId} is not running` };
    if (!job.claudeSessionId) return { ok: false, reason: 'session has no Claude session to resume yet' };
    const live = this.resolver.checkLive('sessionResume', { agentId: job.agentId, claudeSessionId: job.claudeSessionId });
    return live.ok ? { ok: true } : { ok: false, reason: live.reason };
  }

  async run(job: JournalJob): Promise<JournalRunResult> {
    const handle = this.handles.get(job.agentId);
    if (!handle || !job.claudeSessionId) return { outcome: 'unavailable', error: 'no handle or Claude session' };
    const result = await handle.journalSession({
      conversationId: job.conversationId,
      claudeSessionId: job.claudeSessionId,
      contactId: job.contactId,
      channel: job.channel,
      prompt: job.settings.journalers['cc-headless'].prompt,
    });
    if (result.error) {
      return { outcome: 'failed-after-start', error: result.error, fidelity: 'full-session', costUsd: result.costUsd };
    }
    return {
      outcome: 'done',
      fidelity: 'full-session',
      costUsd: result.costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }
}
