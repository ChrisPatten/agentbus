/**
 * E52 — `IncidentStore` over the `pane_incidents` table (migration 020).
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type IncidentClass = 'known_screen' | 'idle_prompt' | 'frozen_turn' | 'unknown_blocked';
export type IncidentResolution = 'recovered' | 'answered' | 'answer_failed' | 'released' | 'superseded';

export interface IncidentAction {
  at: string;
  action: string;
  result: string;
}

export interface IncidentRow {
  id: string;
  pool_id: string;
  pane_id: string;
  conversation_id: string | null;
  class: IncidentClass;
  pattern: string | null;
  detected_at: string;
  unhandled_since: string | null;
  screen_snapshot: string;
  /** Parsed from the JSON `actions` column. */
  actions: IncidentAction[];
  resolved_at: string | null;
  resolution: IncidentResolution | null;
}

export interface InsertIncidentInput {
  poolId: string;
  paneId: string;
  conversationId: string | null;
  class: IncidentClass;
  pattern?: string;
  unhandledSince: string | null;
  screenSnapshot: string;
}

interface RawRow extends Omit<IncidentRow, 'actions'> {
  actions: string | null;
}

function parse(raw: RawRow): IncidentRow {
  let actions: IncidentAction[] = [];
  if (raw.actions) {
    try {
      const v = JSON.parse(raw.actions);
      if (Array.isArray(v)) actions = v as IncidentAction[];
    } catch {
      actions = [];
    }
  }
  return { ...raw, actions };
}

export class IncidentStore {
  constructor(private readonly db: Database.Database) {}

  insert(input: InsertIncidentInput, now: Date = new Date()): IncidentRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pane_incidents
           (id, pool_id, pane_id, conversation_id, class, pattern, detected_at, unhandled_since, screen_snapshot, actions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
      )
      .run(
        id,
        input.poolId,
        input.paneId,
        input.conversationId,
        input.class,
        input.pattern ?? null,
        now.toISOString(),
        input.unhandledSince,
        input.screenSnapshot,
      );
    return this.get(id)!;
  }

  get(id: string): IncidentRow | null {
    const raw = this.db.prepare('SELECT * FROM pane_incidents WHERE id = ?').get(id) as RawRow | undefined;
    return raw ? parse(raw) : null;
  }

  findOpen(poolId: string, paneId: string): IncidentRow | null {
    const raw = this.db
      .prepare(
        `SELECT * FROM pane_incidents
         WHERE pool_id = ? AND pane_id = ? AND resolved_at IS NULL
         ORDER BY detected_at DESC, rowid DESC LIMIT 1`,
      )
      .get(poolId, paneId) as RawRow | undefined;
    return raw ? parse(raw) : null;
  }

  /** Marks an open incident resolved. Returns false if it was missing or already resolved. */
  resolve(id: string, resolution: IncidentResolution, now: Date = new Date()): boolean {
    const res = this.db
      .prepare('UPDATE pane_incidents SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL')
      .run(now.toISOString(), resolution, id);
    return res.changes > 0;
  }

  appendAction(id: string, action: { action: string; result: string }, now: Date = new Date()): boolean {
    const row = this.get(id);
    if (!row) return false;
    const actions = [...row.actions, { at: now.toISOString(), action: action.action, result: action.result }];
    const res = this.db.prepare('UPDATE pane_incidents SET actions = ? WHERE id = ?').run(JSON.stringify(actions), id);
    return res.changes > 0;
  }

  /** Newest first. `open: true` -> unresolved only, `open: false` -> resolved only, omitted -> all. */
  list(opts: { open?: boolean } = {}): IncidentRow[] {
    let where = '';
    if (opts.open === true) where = 'WHERE resolved_at IS NULL';
    else if (opts.open === false) where = 'WHERE resolved_at IS NOT NULL';
    const rows = this.db
      .prepare(`SELECT * FROM pane_incidents ${where} ORDER BY detected_at DESC, rowid DESC`)
      .all() as RawRow[];
    return rows.map(parse);
  }
}
