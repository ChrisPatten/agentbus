/**
 * SQLite-backed store for the `advisories` table (E65 S65.2).
 *
 * Owns the lifecycle `open -> delivered -> acknowledged -> resolved`, keyed by
 * condition: at most one active (non-resolved) advisory per
 * (agent_id, condition_key), enforced by a partial unique index. Delivery
 * decisions live in `./service.ts`; this file has no knowledge of owners,
 * runtimes or channels.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  SEVERITY_RANK,
  type AckResult,
  type Advisory,
  type AdvisoryDeliveryPath,
  type AdvisoryInput,
  type AdvisorySeverity,
  type AdvisoryState,
  type RaiseResult,
} from './types.js';

const toPrefixed = (id: string) => (id.startsWith('agent:') ? id : `agent:${id}`);

export interface ListFilter {
  agentId?: string;
  states?: readonly AdvisoryState[];
  severities?: readonly AdvisorySeverity[];
}

export class AdvisoryStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Raise a condition. Idempotent per active condition: a second raise for
   * the same (agent, condition) updates the existing row instead of adding
   * one. Higher severity escalates in place and reopens the advisory so it
   * is delivered again; lower severity never de-escalates. A raise after
   * `resolve()` opens a fresh row (a recurrence).
   */
  raise(input: AdvisoryInput, now: Date = new Date()): RaiseResult {
    if (!input.remediation.trim()) throw new Error('advisory remediation is required');
    const agentId = toPrefixed(input.agentId);
    const ts = now.toISOString();

    const run = this.db.transaction((): RaiseResult => {
      const existing = this.findActive(agentId, input.conditionKey);
      if (!existing) {
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO advisories
               (id, agent_id, condition_key, severity, title, body, remediation, source, state,
                raised_at, updated_at, last_raised_at, raise_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1)`,
          )
          .run(id, agentId, input.conditionKey, input.severity, input.title, input.body, input.remediation,
            input.source ?? null, ts, ts, ts);
        return { advisory: this.get(id)!, outcome: 'created' };
      }

      if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity]) {
        this.db
          .prepare(
            `UPDATE advisories
             SET severity = ?, title = ?, body = ?, remediation = ?, source = COALESCE(?, source),
                 state = 'open', delivered_at = NULL, delivered_via = NULL, delivery_attempts = 0,
                 last_attempt_at = NULL, last_error = NULL, acknowledged_at = NULL, acknowledged_by = NULL,
                 updated_at = ?, last_raised_at = ?, raise_count = raise_count + 1
             WHERE id = ?`,
          )
          .run(input.severity, input.title, input.body, input.remediation, input.source ?? null, ts, ts, existing.id);
        return { advisory: this.get(existing.id)!, outcome: 'escalated' };
      }

      const textChanged = input.title !== existing.title || input.body !== existing.body
        || input.remediation !== existing.remediation;
      if (textChanged) {
        this.db
          .prepare(
            `UPDATE advisories SET title = ?, body = ?, remediation = ?, updated_at = ?, last_raised_at = ?,
                    raise_count = raise_count + 1
             WHERE id = ?`,
          )
          .run(input.title, input.body, input.remediation, ts, ts, existing.id);
        return { advisory: this.get(existing.id)!, outcome: 'updated' };
      }

      this.db
        .prepare(`UPDATE advisories SET last_raised_at = ?, raise_count = raise_count + 1 WHERE id = ?`)
        .run(ts, existing.id);
      return { advisory: this.get(existing.id)!, outcome: 'unchanged' };
    });
    return run();
  }

  /** Close the active advisory for a condition. Returns it, or null when none was active. */
  resolve(agentId: string, conditionKey: string, now: Date = new Date()): Advisory | null {
    const existing = this.findActive(toPrefixed(agentId), conditionKey);
    if (!existing) return null;
    const ts = now.toISOString();
    this.db
      .prepare(`UPDATE advisories SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`)
      .run(ts, ts, existing.id);
    return this.get(existing.id);
  }

  /**
   * Acknowledge an advisory. When `agentId` is given, the advisory must
   * belong to that agent (prefixed logical id). Acknowledging twice is ok;
   * acknowledging a resolved advisory is not.
   */
  ack(id: string, agentId?: string, now: Date = new Date()): AckResult {
    const advisory = this.get(id);
    if (!advisory) return { ok: false, reason: 'not_found' };
    if (agentId && advisory.agent_id !== toPrefixed(agentId)) return { ok: false, reason: 'wrong_agent' };
    if (advisory.state === 'resolved') return { ok: false, reason: 'resolved', advisory };
    if (advisory.state === 'acknowledged') return { ok: true, advisory, alreadyAcknowledged: true };
    const ts = now.toISOString();
    this.db
      .prepare(
        `UPDATE advisories SET state = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, updated_at = ?,
                delivered_at = COALESCE(delivered_at, ?)
         WHERE id = ?`,
      )
      .run(ts, agentId ? toPrefixed(agentId) : null, ts, ts, id);
    return { ok: true, advisory: this.get(id)!, alreadyAcknowledged: false };
  }

  /** Mark open advisories delivered. Rows no longer `open` are left alone. Returns how many changed. */
  markDelivered(ids: readonly string[], via: AdvisoryDeliveryPath, now: Date = new Date()): number {
    if (ids.length === 0) return 0;
    const ts = now.toISOString();
    const stmt = this.db.prepare(
      `UPDATE advisories SET state = 'delivered', delivered_at = ?, delivered_via = ?, updated_at = ?
       WHERE id = ? AND state = 'open'`,
    );
    let changed = 0;
    for (const id of ids) changed += stmt.run(ts, via, ts, id).changes;
    return changed;
  }

  /** Record one proactive delivery attempt (and its error, if it failed). */
  recordAttempt(id: string, error: string | null, now: Date = new Date()): void {
    this.db
      .prepare(
        `UPDATE advisories SET delivery_attempts = delivery_attempts + 1, last_attempt_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(now.toISOString(), error ? error.slice(0, 500) : null, id);
  }

  get(id: string): Advisory | null {
    return (this.db.prepare(`SELECT * FROM advisories WHERE id = ?`).get(id) as Advisory | undefined) ?? null;
  }

  /** The active (non-resolved) advisory for a condition, if any. */
  findActive(agentId: string, conditionKey: string): Advisory | null {
    return (this.db
      .prepare(`SELECT * FROM advisories WHERE agent_id = ? AND condition_key = ? AND state != 'resolved'`)
      .get(toPrefixed(agentId), conditionKey) as Advisory | undefined) ?? null;
  }

  /** Rows matching the filter, most severe first, then newest first. */
  list(filter: ListFilter = {}): Advisory[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.agentId) {
      where.push('agent_id = ?');
      params.push(toPrefixed(filter.agentId));
    }
    if (filter.states && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      params.push(...filter.states);
    }
    if (filter.severities && filter.severities.length > 0) {
      where.push(`severity IN (${filter.severities.map(() => '?').join(', ')})`);
      params.push(...filter.severities);
    }
    const sql = `SELECT * FROM advisories ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, raised_at DESC`;
    return this.db.prepare(sql).all(...params) as Advisory[];
  }

  /** Active (non-resolved) advisories, optionally for one agent. */
  listActive(agentId?: string): Advisory[] {
    return this.list({ agentId, states: ['open', 'delivered', 'acknowledged'] });
  }
}
