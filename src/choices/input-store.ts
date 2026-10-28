/**
 * S81.8 — SQLite-backed store for the `input_prompts` table (E81 `ask_input`).
 *
 * `open -> answered | expired`, like choice_prompts. A prompt is matched to an
 * inbound answer by chat, forum topic and kind (location / contact / person),
 * or by the platform id of the prompt message a force_reply text answer
 * replies to.
 */
import type Database from 'better-sqlite3';

export type InputKind = 'location' | 'contact' | 'person' | 'text';
export type InputPromptStatus = 'open' | 'answered' | 'expired';

export interface InputPrompt {
  id: string;
  channel: string;
  topic: string;
  contact_id: string | null;
  kind: InputKind;
  chat_id: number;
  thread_id: number | null;
  platform_message_id: number | null;
  bus_message_id: string | null;
  request_id: number | null;
  /** 1 while a reply keyboard is on the user's screen and still needs removing. */
  keyboard: number;
  status: InputPromptStatus;
  answered_at: string | null;
  created_at: string;
  expires_at: string;
}

export interface InputPromptInput {
  id: string;
  channel: string;
  topic: string;
  contactId: string | null;
  kind: InputKind;
  chatId: number;
  threadId: number | null;
  platformMessageId: number | null;
  busMessageId: string | null;
  requestId?: number | null;
  keyboard: boolean;
}

export class InputPromptStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: InputPromptInput, ttlMs: number, now: Date = new Date()): InputPrompt {
    this.db
      .prepare(
        `INSERT INTO input_prompts
           (id, channel, topic, contact_id, kind, chat_id, thread_id, platform_message_id, bus_message_id,
            request_id, keyboard, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        input.id,
        input.channel,
        input.topic,
        input.contactId,
        input.kind,
        input.chatId,
        input.threadId,
        input.platformMessageId,
        input.busMessageId,
        input.requestId ?? null,
        input.keyboard ? 1 : 0,
        now.toISOString(),
        new Date(now.getTime() + ttlMs).toISOString(),
      );
    return this.getById(input.id)!;
  }

  getById(id: string): InputPrompt | null {
    return (this.db.prepare(`SELECT * FROM input_prompts WHERE id = ?`).get(id) as InputPrompt | undefined) ?? null;
  }

  /**
   * The newest unexpired `open` prompt of `kind` in a chat/topic that `contactId`
   * may answer, or null. Expired-but-unswept rows are ignored.
   */
  findOpen(
    kind: InputKind,
    chatId: number,
    threadId: number | null,
    contactId: string,
    nowIso: string = new Date().toISOString(),
  ): InputPrompt | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM input_prompts
           WHERE status = 'open' AND kind = ? AND chat_id = ? AND thread_id IS ? AND expires_at >= ?
             AND (contact_id IS NULL OR contact_id = ?)
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(kind, chatId, threadId, nowIso, contactId) as InputPrompt | undefined) ?? null
    );
  }

  /** The open prompt whose message an answer replied to (the force_reply path, any kind). */
  findOpenByMessage(chatId: number, platformMessageId: number, contactId: string, nowIso: string = new Date().toISOString()): InputPrompt | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM input_prompts
           WHERE status = 'open' AND chat_id = ? AND platform_message_id = ? AND expires_at >= ?
             AND (contact_id IS NULL OR contact_id = ?)
           LIMIT 1`,
        )
        .get(chatId, platformMessageId, nowIso, contactId) as InputPrompt | undefined) ?? null
    );
  }

  /** `open -> answered`; false if it was no longer open (an answer racing another). */
  markAnswered(id: string, now: Date = new Date()): boolean {
    return (
      this.db
        .prepare(`UPDATE input_prompts SET status = 'answered', answered_at = ? WHERE id = ? AND status = 'open'`)
        .run(now.toISOString(), id).changes > 0
    );
  }

  /** The keyboard has been removed (or never needs removing). */
  clearKeyboard(id: string): void {
    this.db.prepare(`UPDATE input_prompts SET keyboard = 0 WHERE id = ?`).run(id);
  }

  /** `open -> expired` for every prompt past `expires_at`. */
  expireDue(nowIso: string = new Date().toISOString()): number {
    return this.db
      .prepare(`UPDATE input_prompts SET status = 'expired' WHERE status = 'open' AND expires_at < ?`)
      .run(nowIso).changes;
  }

  /** Answered or expired prompts whose reply keyboard may still be showing. */
  listNeedingKeyboardCleanup(): InputPrompt[] {
    return this.db
      .prepare(`SELECT * FROM input_prompts WHERE keyboard = 1 AND status IN ('expired', 'answered')`)
      .all() as InputPrompt[];
  }
}
