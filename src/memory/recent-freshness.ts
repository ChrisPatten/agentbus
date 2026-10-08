/**
 * `recent.md` freshness for live sessions (E67 S67.4). See
 * docs/AGENT_MEMORY.md#freshness-hook.
 *
 * A long-lived Claude Code session (a cc-pool pane) loads `recent.md` once,
 * through its `CLAUDE.md` import, at launch, `/compact` or `/clear`. When a
 * journal run or the midnight rollover changes the file later, the
 * `UserPromptSubmit` hook asks `GET /api/v1/memory/recent` and gets the new
 * content, only when its hash differs from what that session last saw.
 *
 * Baseline: a `session-start` check (the same hook on `SessionStart`) records
 * the current hash without returning content, because the session has just
 * loaded the file. Without a SessionStart registration, a session's first
 * prompt check is the baseline instead.
 */
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { hashContent } from './recent.js';
import type { RecentMemory } from './recent-service.js';

export type FreshnessEvent = 'prompt' | 'session-start';

export interface FreshnessRequest {
  harnessSessionId: string;
  event?: FreshnessEvent;
  /** Fallback when the session id resolves to no agent (e.g. a `claude-code` session): bare or prefixed agent id. */
  agentId?: string;
}

export type FreshnessResult =
  | {
      ok: true;
      agent_id: string;
      /** True when `context` carries content the session hasn't seen. */
      changed: boolean;
      /** Why nothing was returned, when `changed` is false. */
      reason?: 'baseline' | 'unchanged' | 'no-recent';
      hash: string | null;
      /** Text for the hook to print as additional context. */
      context?: string;
    }
  | { ok: false; status: number; error: string };

export interface RecentFreshnessDeps {
  db: Database.Database;
  recent: Pick<RecentMemory, 'regenerate' | 'layoutFor'>;
  /** Logical agent for a harness session id (bus session, then pool pane), or null. */
  resolveAgent: (harnessSessionId: string) => string | null;
  /** Whether a fallback agent id names a configured agent. */
  knownAgent?: (agentId: string) => boolean;
  now?: () => Date;
}

const RETENTION_MS = 30 * 86_400_000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

export function freshnessContext(relPath: string, content: string): string {
  return (
    `AgentBus: ${relPath} (your recent daily journals) changed since this session loaded it. ` +
    'This is the current version; it replaces the earlier one.\n\n' +
    content
  );
}

export class RecentFreshness {
  private lastSweep = 0;

  constructor(private readonly deps: RecentFreshnessDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  check(req: FreshnessRequest): FreshnessResult {
    const fromSession = this.deps.resolveAgent(req.harnessSessionId);
    const fallback = req.agentId && (this.deps.knownAgent?.(req.agentId) ?? false) ? req.agentId : null;
    const agentId = fromSession ?? fallback;
    if (!agentId) return { ok: false, status: 404, error: 'no agent for this harness_session_id' };

    // Regenerate first, so dailies written in-turn since the last journal run are picked up.
    const written = this.deps.recent.regenerate(agentId, 'hook');
    const layout = this.deps.recent.layoutFor(agentId);
    let content: string | null = null;
    if (layout.recentPath) {
      try {
        content = readFileSync(layout.recentPath, 'utf-8');
      } catch {
        content = null;
      }
    }
    if (content === null) {
      return { ok: true, agent_id: layout.agentId, changed: false, reason: 'no-recent', hash: null };
    }
    const hash = written.hash ?? hashContent(content);
    const now = this.now().toISOString();
    const row = this.deps.db
      .prepare('SELECT content_hash FROM memory_recent_seen WHERE harness_session_id = ?')
      .get(req.harnessSessionId) as { content_hash: string } | undefined;
    this.deps.db
      .prepare(
        `INSERT INTO memory_recent_seen (harness_session_id, agent_id, content_hash, seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (harness_session_id) DO UPDATE SET agent_id = excluded.agent_id, content_hash = excluded.content_hash, seen_at = excluded.seen_at`,
      )
      .run(req.harnessSessionId, layout.agentId, hash, now);
    this.sweep();

    if (req.event === 'session-start' || !row) {
      return { ok: true, agent_id: layout.agentId, changed: false, reason: 'baseline', hash };
    }
    if (row.content_hash === hash) {
      return { ok: true, agent_id: layout.agentId, changed: false, reason: 'unchanged', hash };
    }
    const rel = `${layout.dir.replace(/\/+$/, '')}/recent.md`;
    return { ok: true, agent_id: layout.agentId, changed: true, hash, context: freshnessContext(rel, content) };
  }

  /** Drop rows untouched for 30 days (at most hourly). */
  sweep(): number {
    const now = this.now().getTime();
    if (now - this.lastSweep < SWEEP_EVERY_MS) return 0;
    this.lastSweep = now;
    const cutoff = new Date(now - RETENTION_MS).toISOString();
    return this.deps.db.prepare('DELETE FROM memory_recent_seen WHERE seen_at < ?').run(cutoff).changes;
  }
}

/** Parse the query string of `GET /api/v1/memory/recent`. */
export function parseFreshnessQuery(q: Record<string, unknown>): FreshnessRequest | { error: string } {
  const id = q['harness_session_id'];
  if (typeof id !== 'string' || id.length === 0) return { error: 'harness_session_id is required' };
  const event = q['event'];
  if (event !== undefined && event !== 'prompt' && event !== 'session-start') return { error: 'event must be prompt or session-start' };
  const agent = q['agent'];
  return {
    harnessSessionId: id,
    ...(event ? { event } : {}),
    ...(typeof agent === 'string' && agent.length > 0 ? { agentId: agent } : {}),
  };
}
