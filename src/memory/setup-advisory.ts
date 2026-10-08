/**
 * Memory setup advisory (E68 follow-up to E67 S67.5): an agent that loads
 * memory natively but whose CLAUDE.md doesn't import `recent.md` stops seeing
 * its recent journals. The setup check already logs this at startup and shows
 * it in `/journal`; this raises it to the owners through the E65 advisory
 * service too, one advisory per agent, and resolves it once the import is
 * there. See docs/AGENT_MEMORY.md#setup-checks.
 *
 *   memory:recent-not-imported   warning   native loading, CLAUDE.md (with its
 *                                          imports) doesn't import recent.md
 *
 * Checked at startup, whenever `/journal` runs the setup check, after each
 * successful journal run and on a slow timer (`MEMORY_SETUP_RECHECK_MS`).
 */
import type { AdvisoryService } from '../advisories/service.js';
import type { MemoryLayout } from './layout.js';
import type { MemorySetupStatus } from './setup-check.js';

export const RECENT_NOT_IMPORTED_CONDITION = 'memory:recent-not-imported';

/** How often the bus re-checks every agent's setup between other triggers. */
export const MEMORY_SETUP_RECHECK_MS = 15 * 60 * 1000;

export type MemorySetupAdvisories = Pick<AdvisoryService, 'raise' | 'resolve'>;

/** True when the status shows native loading without the recent.md import. */
export function missesRecentImport(status: Pick<MemorySetupStatus, 'loading' | 'importsRecent'>): boolean {
  return status.loading === 'native' && status.importsRecent === false;
}

/**
 * Raise or resolve `memory:recent-not-imported` for one agent's setup status.
 * `importsRecent: null` (no working dir, so nothing to read) resolves it:
 * the bus can't tell, and the startup log already says so.
 */
export function syncMemorySetupAdvisory(
  advisories: MemorySetupAdvisories | undefined,
  status: MemorySetupStatus,
  layout: Pick<MemoryLayout, 'dir' | 'recentPath'>,
): 'raised' | 'resolved' {
  if (!missesRecentImport(status)) {
    advisories?.resolve(status.agentId, RECENT_NOT_IMPORTED_CONDITION);
    return 'resolved';
  }
  // The import line, as the setup check words it (memory dir setting + recent.md).
  const rel = `${layout.dir.replace(/\/+$/, '')}/recent.md`;
  const target = layout.recentPath ?? rel;
  const noClaudeMd = status.claudeMdFiles.length === 0;
  advisories?.raise({
    agentId: status.agentId,
    conditionKey: RECENT_NOT_IMPORTED_CONDITION,
    severity: 'warning',
    title: 'The agent does not see its recent journals',
    body: noClaudeMd
      ? `The agent loads memory natively, but its working dir has no CLAUDE.md, so nothing imports ${target}. ` +
        'It still sees MEMORY.md, but not the last few days of journals.'
      : `The agent loads memory natively, but its CLAUDE.md (and the files it imports) doesn't import ${target}. ` +
        'It still sees MEMORY.md, but not the last few days of journals.',
    remediation:
      `${noClaudeMd ? "Create the agent's CLAUDE.md with" : 'Add'} the line @${rel} ` +
      "to the agent's CLAUDE.md. The advisory resolves on its own once the import is there (checked after journal runs, " +
      'by /journal, and every 15 minutes).',
    source: 'memory',
  });
  return 'raised';
}

