/**
 * S74.2 — SQLite-backed store for the `choice_prompts` table (E74).
 *
 * Owns every state transition a prompt can go through
 * (`open -> answered | expired`). Mirrors src/approvals/store.ts: a small,
 * synchronous (better-sqlite3) wrapper with no business logic beyond the
 * state machine.
 */
import type Database from 'better-sqlite3';
import type { AnswerChoiceOutcome, ChoicePrompt, ChoicePromptInput, ChoicePromptStatus } from './types.js';

interface ChoicePromptRow extends Omit<ChoicePrompt, 'labels' | 'commands'> {
  labels: string;
  commands: string | null;
}

function toPrompt(row: ChoicePromptRow): ChoicePrompt {
  return {
    ...row,
    labels: JSON.parse(row.labels) as string[],
    commands: row.commands ? (JSON.parse(row.commands) as Array<string | null>) : null,
  };
}

export class ChoiceStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Creates an `open` prompt expiring `ttlMs` after `now`. */
  create(input: ChoicePromptInput, ttlMs: number, now: Date = new Date()): ChoicePrompt {
    this.db
      .prepare(
        `INSERT INTO choice_prompts
           (id, channel, topic, contact_id, labels, commands, platform_message_id, bus_message_id, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        input.id,
        input.channel,
        input.topic,
        input.contactId,
        JSON.stringify(input.labels),
        input.commands && input.commands.some((c) => c) ? JSON.stringify(input.commands) : null,
        input.platformMessageId,
        input.busMessageId,
        now.toISOString(),
        new Date(now.getTime() + ttlMs).toISOString(),
      );
    return this.getById(input.id)!;
  }

  getById(id: string): ChoicePrompt | null {
    const row = this.db.prepare(`SELECT * FROM choice_prompts WHERE id = ?`).get(id) as ChoicePromptRow | undefined;
    return row ? toPrompt(row) : null;
  }

  /** All prompts, optionally by status, newest first (observability). */
  list(status?: ChoicePromptStatus): ChoicePrompt[] {
    const rows = (
      status
        ? this.db.prepare(`SELECT * FROM choice_prompts WHERE status = ? ORDER BY created_at DESC`).all(status)
        : this.db.prepare(`SELECT * FROM choice_prompts ORDER BY created_at DESC`).all()
    ) as ChoicePromptRow[];
    return rows.map(toPrompt);
  }

  /**
   * Records a tap. The `open -> answered` flip is a single conditional UPDATE,
   * so two racing taps cannot both succeed: the loser sees `already_answered`.
   * A tap on an `open` prompt past its `expires_at` flips it to `expired`
   * (keeping the message ref so the keyboard can still be cleaned up).
   */
  answer(id: string, index: number, answeredBy: string, now: Date = new Date()): AnswerChoiceOutcome {
    const prompt = this.getById(id);
    if (!prompt) return { outcome: 'not_found' };
    if (prompt.status === 'answered') return { outcome: 'already_answered', prompt };
    if (prompt.status === 'expired') return { outcome: 'expired', prompt };
    const nowIso = now.toISOString();
    if (prompt.expires_at < nowIso) {
      this.db
        .prepare(`UPDATE choice_prompts SET status = 'expired' WHERE id = ? AND status = 'open'`)
        .run(id);
      return { outcome: 'expired', prompt: { ...prompt, status: 'expired' } };
    }
    if (!Number.isInteger(index) || index < 0 || index >= prompt.labels.length) {
      return { outcome: 'invalid_choice', prompt };
    }
    const result = this.db
      .prepare(
        `UPDATE choice_prompts
         SET status = 'answered', chosen_index = ?, answered_by = ?, answered_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(index, answeredBy, nowIso, id);
    if (result.changes === 0) {
      return { outcome: 'already_answered', prompt: this.getById(id)! };
    }
    return {
      outcome: 'answered',
      prompt: { ...prompt, status: 'answered', chosen_index: index, answered_by: answeredBy, answered_at: nowIso },
      label: prompt.labels[index]!,
    };
  }

  /**
   * Undoes `answer()` for a prompt whose tap could not be delivered to the
   * agent, so the human can tap again. No-op unless currently `answered`.
   */
  reopen(id: string): void {
    this.db
      .prepare(
        `UPDATE choice_prompts
         SET status = 'open', chosen_index = NULL, answered_by = NULL, answered_at = NULL
         WHERE id = ? AND status = 'answered'`,
      )
      .run(id);
  }

  /**
   * `open -> expired` for every prompt past `expires_at`. Returns the rows
   * transitioned (their keyboards need clearing).
   */
  expireDue(nowIso: string = new Date().toISOString()): ChoicePrompt[] {
    const due = (
      this.db.prepare(`SELECT * FROM choice_prompts WHERE status = 'open' AND expires_at < ?`).all(nowIso) as ChoicePromptRow[]
    ).map(toPrompt);
    if (due.length === 0) return [];
    const update = this.db.prepare(`UPDATE choice_prompts SET status = 'expired' WHERE id = ? AND status = 'open'`);
    this.db.transaction((rows: ChoicePrompt[]) => {
      for (const row of rows) update.run(row.id);
    })(due);
    return due.map((p) => ({ ...p, status: 'expired' as const }));
  }

  /** Expired prompts whose keyboard has not yet been cleared (still have a message ref). */
  listNeedingKeyboardCleanup(): ChoicePrompt[] {
    return (
      this.db
        .prepare(`SELECT * FROM choice_prompts WHERE status = 'expired' AND platform_message_id IS NOT NULL`)
        .all() as ChoicePromptRow[]
    ).map(toPrompt);
  }

  /** Marks a prompt's keyboard as cleaned up. */
  clearMessageRef(id: string): void {
    this.db.prepare(`UPDATE choice_prompts SET platform_message_id = NULL WHERE id = ?`).run(id);
  }
}
