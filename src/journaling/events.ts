/**
 * Harness events and hook health (E66 S66.4).
 *
 * `POST /api/v1/journal/events { harness_session_id, event, snapshot_path?, transcript_path? }`
 * is posted by `scripts/hooks/agentbus_journal_hook.sh`. The bus resolves the
 * agent and conversation from the harness session id (the Claude session id
 * it stored for the session), so hooks carry no per-deployment constants.
 *
 *   turn-ended   re-anchor the pause clock (and mark the pool pane's turn
 *                ended, replacing the old pool Stop hook endpoint). Never journals.
 *   pre-compact  "preserve now, journal later": register the snapshot the hook
 *   clear        saved, then fire the final trigger of the same name.
 *   session-end  final trigger (snapshot registered when sent).
 *
 * Snapshot paths must be absolute, exist, and resolve inside the agent's
 * working directory or `~/.agentbus/journal-snapshots`, so a caller cannot
 * point journalers at arbitrary files.
 *
 * Hook health: a runtime that declares an event in `hookEvents` but never
 * sends it is visible in `hookHealth()` (shown by `/journal` in part B). Only
 * `turn-ended` can be judged from its absence (every agent turn should send
 * one). A hook that used to report `turn-ended` and has gone quiet while the
 * agent keeps answering raises a `warning` advisory; one that was never
 * seen does not, since hooks are optional.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { HOOK_EVENTS, type HookEvent } from '../core/runtime-capabilities.js';
import type { AgentRuntime } from '../core/runtime-resolver.js';
import type { SessionRow } from '../memory/types.js';
import { hookStoppedCondition, type JournalAdvisories } from './advisories.js';
import type { JournalEngine, TriggerHandle } from './engine.js';
import type { JournalStore } from './store.js';

/** Default directory the generic hook writes snapshots to (besides the agent's working dir). */
export const DEFAULT_SNAPSHOT_DIR = join(homedir(), '.agentbus', 'journal-snapshots');
/** How long agent activity may go without a `turn-ended` before the hook counts as stopped. */
export const TURN_ENDED_GRACE_MS = 10 * 60 * 1000;

export interface HarnessEventInput {
  harness_session_id: string;
  event: HookEvent;
  snapshot_path?: string;
  transcript_path?: string;
}

export type HarnessEventResult =
  | {
      ok: true;
      session_id: string;
      agent_id: string;
      action: 'turn-ended' | 'triggered';
      trigger?: TriggerHandle['status'];
      snapshot_id?: string;
      snapshot_error?: string;
    }
  | { ok: false; status: 400 | 404; error: string };

export interface PoolTurnEndedSink {
  poolId: string;
  leaseStore: {
    list(poolId: string): Array<{ pane_id: string; claude_session_id: string | null }>;
    markTurnEnded(poolId: string, paneId: string): void;
  };
}

export interface HarnessEventDeps {
  db: Database.Database;
  engine: Pick<JournalEngine, 'trigger' | 'noteTurnEnded' | 'agentForSession'>;
  store: JournalStore;
  /** Keyed by prefixed pool id. Lets turn-ended also mark the pane's turn ended. */
  poolManagers?: Map<string, PoolTurnEndedSink>;
  snapshotRoots?: readonly string[];
  now?: () => Date;
}

const isHookEvent = (e: unknown): e is HookEvent => typeof e === 'string' && (HOOK_EVENTS as readonly string[]).includes(e);

export function parseHarnessEvent(body: unknown): HarnessEventInput | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b['harness_session_id'] !== 'string' || b['harness_session_id'].length === 0) {
    return { error: 'harness_session_id is required' };
  }
  if (!isHookEvent(b['event'])) return { error: `event must be one of ${HOOK_EVENTS.join(', ')}` };
  for (const key of ['snapshot_path', 'transcript_path'] as const) {
    if (b[key] !== undefined && (typeof b[key] !== 'string' || (b[key] as string).length === 0)) {
      return { error: `${key} must be a non-empty string` };
    }
  }
  return {
    harness_session_id: b['harness_session_id'],
    event: b['event'],
    ...(typeof b['snapshot_path'] === 'string' ? { snapshot_path: b['snapshot_path'] } : {}),
    ...(typeof b['transcript_path'] === 'string' ? { transcript_path: b['transcript_path'] } : {}),
  };
}

function within(path: string, root: string): boolean {
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return false; }
  return path === realRoot || path.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}

/** Validate a snapshot path. Returns the resolved path or an error. */
export function checkSnapshotPath(path: string, roots: readonly string[]): { path: string } | { error: string } {
  if (!isAbsolute(path)) return { error: 'snapshot_path must be absolute' };
  if (!existsSync(path)) return { error: 'snapshot_path does not exist' };
  let real: string;
  try {
    real = realpathSync(path);
    if (!statSync(real).isFile()) return { error: 'snapshot_path is not a file' };
  } catch (err) {
    return { error: `snapshot_path unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!roots.some((root) => within(real, root))) {
    return { error: 'snapshot_path is outside the agent working directory and ~/.agentbus/journal-snapshots' };
  }
  return { path: real };
}

export class HarnessEvents {
  constructor(private readonly deps: HarnessEventDeps) {}

  /** The bus session a harness session id belongs to: open sessions first, newest first. */
  findSession(harnessSessionId: string): SessionRow | null {
    const bySession = this.deps.db
      .prepare(`SELECT * FROM sessions WHERE claude_session_id = ? ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT 1`)
      .get(harnessSessionId) as SessionRow | undefined;
    if (bySession) return bySession;
    const byState = this.deps.db
      .prepare(
        `SELECT s.* FROM journal_state js JOIN sessions s ON s.id = js.session_id
         WHERE js.harness_session_id = ? ORDER BY (s.ended_at IS NULL) DESC, s.started_at DESC LIMIT 1`,
      )
      .get(harnessSessionId) as SessionRow | undefined;
    return byState ?? null;
  }

  handle(input: HarnessEventInput): HarnessEventResult {
    const session = this.findSession(input.harness_session_id);
    if (!session) {
      // A pool pane can know its Claude session id before the bus session
      // row does; still keep the pane's idle timing right.
      if (input.event === 'turn-ended' && this.markAnyPoolTurnEnded(input.harness_session_id)) {
        return { ok: false, status: 404, error: 'no bus session for this harness_session_id (pane turn marked ended)' };
      }
      return { ok: false, status: 404, error: 'no bus session for this harness_session_id' };
    }
    const agent = this.deps.engine.agentForSession(session);
    if (!agent) return { ok: false, status: 404, error: 'session has no agent' };
    const now = (this.deps.now?.() ?? new Date()).toISOString();

    this.deps.store.recordHookEvent(agent.agentId, input.event, now);
    this.deps.store.noteHarness(session.id, input.harness_session_id, input.transcript_path ?? null);

    if (input.event === 'turn-ended') {
      this.deps.engine.noteTurnEnded(session.id, now);
      this.markPoolTurnEnded(agent.runtime, input.harness_session_id);
      return { ok: true, session_id: session.id, agent_id: agent.agentId, action: 'turn-ended' };
    }

    let snapshotId: string | undefined;
    let snapshotError: string | undefined;
    if (input.snapshot_path) {
      const roots = [...(this.deps.snapshotRoots ?? [DEFAULT_SNAPSHOT_DIR])];
      if (agent.runtime && (agent.runtime.kind === 'cc-headless' || agent.runtime.kind === 'cc-pool')) {
        roots.push(agent.runtime.workingDir);
      }
      const checked = checkSnapshotPath(input.snapshot_path, roots);
      if ('error' in checked) snapshotError = checked.error;
      else snapshotId = this.deps.store.addSnapshot(session.id, input.event, checked.path).id;
    }

    const handle = this.deps.engine.trigger({ reason: input.event, sessionId: session.id });
    return {
      ok: true, session_id: session.id, agent_id: agent.agentId, action: 'triggered', trigger: handle.status,
      ...(snapshotId ? { snapshot_id: snapshotId } : {}),
      ...(snapshotError ? { snapshot_error: snapshotError } : {}),
    };
  }

  private markAnyPoolTurnEnded(harnessSessionId: string): boolean {
    for (const manager of this.deps.poolManagers?.values() ?? []) {
      const pane = manager.leaseStore.list(manager.poolId).find((p) => p.claude_session_id === harnessSessionId);
      if (pane) {
        manager.leaseStore.markTurnEnded(manager.poolId, pane.pane_id);
        return true;
      }
    }
    return false;
  }

  private markPoolTurnEnded(runtime: AgentRuntime | undefined, harnessSessionId: string): void {
    if (runtime?.kind !== 'cc-pool') return;
    const manager = this.deps.poolManagers?.get(runtime.poolAgentId);
    if (!manager) return;
    const pane = manager.leaseStore.list(manager.poolId).find((p) => p.claude_session_id === harnessSessionId);
    if (pane) manager.leaseStore.markTurnEnded(manager.poolId, pane.pane_id);
  }
}

// ── Hook health ─────────────────────────────────────────────────────────────

export type HookStatus =
  | 'ok'            // seen, and (for turn-ended) keeping up with agent activity
  | 'never-seen'    // declared, no event yet although the agent has been active
  | 'stopped'       // turn-ended used to arrive; agent activity continues without it
  | 'unverifiable'  // declared but rare by nature (pre-compact, clear, session-end) and not seen
  | 'idle';         // declared, not seen, and no agent activity to expect it from

export interface HookHealthEntry {
  event: HookEvent;
  status: HookStatus;
  lastSeenAt: string | null;
  count: number;
}

/** Newest agent message in the agent's open sessions (pane ids included for pools). */
function lastAgentActivity(db: Database.Database, agentId: string): string | null {
  const row = db
    .prepare(
      `SELECT MAX(t.created_at) AS at FROM transcripts t JOIN sessions s ON s.id = t.session_id
       WHERE s.ended_at IS NULL AND t.direction = 'outbound'
         AND json_extract(t.metadata, '$.command_response') IS NOT 1
         AND (s.agent_id = ? OR s.agent_id LIKE ? ESCAPE '\\')`,
    )
    .get(agentId, `${agentId.replace(/[\\%_]/g, (c) => `\\${c}`)}-pool-%`) as { at: string | null };
  return row.at;
}

export function hookHealth(
  db: Database.Database,
  store: JournalStore,
  agentId: string,
  runtime: Pick<AgentRuntime, 'capabilities'>,
  now: Date = new Date(),
): HookHealthEntry[] {
  const seen = new Map(store.hookEvents(agentId).map((e) => [e.event, e]));
  const activity = lastAgentActivity(db, agentId);
  return runtime.capabilities.hookEvents.map((event) => {
    const s = seen.get(event);
    const lastSeenAt = s?.last_seen_at ?? null;
    const count = s?.count ?? 0;
    let status: HookStatus;
    if (event !== 'turn-ended') {
      status = s ? 'ok' : 'unverifiable';
    } else if (!activity) {
      status = s ? 'ok' : 'idle';
    } else if (!s) {
      status = now.getTime() - new Date(activity).getTime() >= TURN_ENDED_GRACE_MS ? 'never-seen' : 'idle';
    } else {
      const lag = new Date(activity).getTime() - new Date(s.last_seen_at).getTime();
      status = lag >= TURN_ENDED_GRACE_MS && now.getTime() - new Date(activity).getTime() >= TURN_ENDED_GRACE_MS ? 'stopped' : 'ok';
    }
    return { event, status, lastSeenAt, count };
  });
}

/**
 * Engine ticker: raise `journaling:hook-stopped:turn-ended` (warning) for
 * agents whose turn-ended hook stopped reporting, resolve it once it reports
 * again.
 */
export function createHookHealthTicker(deps: {
  db: Database.Database;
  store: JournalStore;
  agents: () => Array<{ agentId: string; runtime: AgentRuntime | undefined }>;
  advisories?: JournalAdvisories;
  now?: () => Date;
}): () => void {
  return () => {
    for (const { agentId, runtime } of deps.agents()) {
      if (!runtime || !runtime.capabilities.hookEvents.includes('turn-ended')) continue;
      const entry = hookHealth(deps.db, deps.store, agentId, runtime, deps.now?.() ?? new Date())
        .find((e) => e.event === 'turn-ended');
      if (!entry) continue;
      const condition = hookStoppedCondition('turn-ended');
      if (entry.status === 'stopped') {
        deps.advisories?.raise({
          agentId,
          conditionKey: condition,
          severity: 'warning',
          title: 'The journal hook stopped reporting',
          body: `The agent keeps answering, but its turn-ended hook has not reported since ${entry.lastSeenAt}. ` +
            'Journaling still works from bus-side tracking, but pause timing is less precise.',
          remediation: 'Check that scripts/hooks/agentbus_journal_hook.sh is still installed as the Stop hook in the agent\'s ' +
            '.claude/settings.json, that jq and curl are on its PATH, and that it can reach the bus (AGENTBUS_URL, and AGENTBUS_BUS_TOKEN when bus.auth_token is set).',
          source: 'journaling',
        });
      } else if (entry.status === 'ok') {
        deps.advisories?.resolve(agentId, condition);
      }
    }
  };
}
