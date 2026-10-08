/**
 * Protected-path monitor (E68 S68.4): hash an agent's protected files
 * before and after every journal run, whatever the journaler, and raise a
 * `warning` advisory listing the files that changed without an approved
 * proposal. Approved proposals (S68.3) register the hash they wrote with
 * `noteApproved`, so the bus's own writes are not reported.
 *
 * The check covers changes made while the run was open by anything: the
 * journaler, the live agent on another turn, or a person editing the file.
 * The advisory says so; it is a prompt to review, not proof of fault.
 */
import type { AppConfig } from '../config/schema.js';
import type { AgentRuntime } from '../core/runtime-resolver.js';
import type { JournalAdvisories } from '../journaling/advisories.js';
import type { ChainRunSummary, RunGuard } from '../journaling/runner.js';
import type { JournalJob } from '../journaling/types.js';
import {
  denyablePaths,
  diffProtected,
  displayPath,
  resolveProtectedPaths,
  snapshotProtected,
  type ProtectedPaths,
  type ProtectedSnapshot,
} from './protected-paths.js';

export const PROTECTED_CHANGE_CONDITION = 'protected-paths:unapproved-change';

export interface ProtectedPathMonitorDeps {
  config: AppConfig;
  resolver: { resolve(agentId: string): AgentRuntime | undefined };
  advisories?: JournalAdvisories;
  log?: (line: string) => void;
}

export class ProtectedPathMonitor implements RunGuard<ProtectedSnapshot | null> {
  private readonly cache = new Map<string, ProtectedPaths>();
  /** Absolute path → hashes the bus wrote for approved proposals, not yet seen by a check. */
  private readonly approved = new Map<string, Set<string>>();

  constructor(private readonly deps: ProtectedPathMonitorDeps) {}

  /** Resolved protected paths of an agent (any id form). */
  paths(agentId: string): ProtectedPaths {
    const hit = this.cache.get(agentId);
    if (hit) return hit;
    const resolved = resolveProtectedPaths(this.deps.config, this.deps.resolver, agentId);
    this.cache.set(agentId, resolved);
    return resolved;
  }

  /** `JournalJob.protectedPaths`: absolute paths that deny rules can cover. */
  jobPaths(agentId: string): string[] {
    return denyablePaths(this.paths(agentId));
  }

  /** The bus applied an approved change: `hash` at `path` is not an unapproved edit. */
  noteApproved(path: string, hash: string): void {
    const set = this.approved.get(path) ?? new Set<string>();
    set.add(hash);
    this.approved.set(path, set);
  }

  begin(job: JournalJob): ProtectedSnapshot | null {
    const paths = this.paths(job.agentId);
    return paths.entries.length > 0 ? snapshotProtected(paths) : null;
  }

  /** Returns the unapproved changes (display paths); raises the advisory when there are any. */
  end(job: JournalJob, before: ProtectedSnapshot | null, summary: ChainRunSummary): string[] {
    if (!before) return [];
    const paths = this.paths(job.agentId);
    const changed = diffProtected(before, snapshotProtected(paths)).filter(({ path, hash }) => {
      const ok = this.approved.get(path);
      if (!ok?.has(hash)) return true;
      ok.delete(hash);
      if (ok.size === 0) this.approved.delete(path);
      return false;
    });
    if (changed.length === 0) return [];
    const files = changed.map((c) => `${displayPath(paths, c.path)}${c.hash === 'absent' ? ' (deleted)' : ''}`);
    const ran = summary.attempts.filter((a) => a.outcome !== 'unavailable').map((a) => a.journaler);
    (this.deps.log ?? ((l: string) => console.warn(l)))(
      `[learning] ${job.agentId}: protected file(s) changed during ${job.kind} run ${job.runId.slice(0, 8)} without an approved proposal: ${files.join(', ')}`,
    );
    this.deps.advisories?.raise({
      agentId: job.agentId,
      conditionKey: PROTECTED_CHANGE_CONDITION,
      severity: 'warning',
      title: 'Protected files changed without approval',
      body:
        `While a ${job.kind === 'consolidate' ? 'consolidation' : 'journal'} run was open (run ${job.runId.slice(0, 8)}` +
        `${ran.length > 0 ? `, ${ran.join(' → ')}` : ''}), these protected files changed without an approved proposal: ${files.join(', ')}. ` +
        'The change may come from the run, the agent on another turn, or someone editing the file.',
      remediation:
        'Review the change (for example with git diff in the agent\'s working directory) and revert what you did not intend. ' +
        'The agent should propose changes to protected files with the propose_change tool. Acknowledge this advisory once reviewed.',
      source: 'learning',
    });
    return files;
  }
}
