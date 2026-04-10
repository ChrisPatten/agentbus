/**
 * MessageEnvelope — the canonical message type for the entire bus.
 * Every message is represented as a MessageEnvelope from the moment it enters the pipeline.
 */
export interface MessageEnvelope {
  /** UUID v4, generated at normalization stage */
  id: string;
  /**
   * ISO 8601 timestamp representing when the message was created or sent by
   * the originating platform. Set during pipeline normalization (Stage 1).
   *
   * When a message is stored to the DB this value becomes `created_at` on the
   * `message_queue` row. When the envelope is later reconstructed from the DB
   * (e.g., during `dequeue`), `timestamp` is repopulated from `created_at`.
   * For real-time messages the values are effectively identical; for messages
   * replayed or re-enqueued the original send time is preserved here while
   * `created_at` reflects the insertion time.
   */
  timestamp: string;
  /** "telegram" | "bluebubbles" | "claude-code" */
  channel: string;
  /** "general" | "reminders" | "code" | "personal" | ... */
  topic: string;
  /** "contact:alice" | "agent:claude" */
  sender: string;
  /** "agent:claude" | "contact:alice" */
  recipient: string;
  /** id of message being replied to, or null */
  reply_to: string | null;
  priority: 'normal' | 'high' | 'urgent';
  payload: MessagePayload;
  /** Platform-specific extras and pipeline annotations */
  metadata: Record<string, unknown>;
}

/** The message payload — discriminated union on `type` */
export type MessagePayload =
  | { type: 'text'; body: string }
  | { type: 'slash_command'; body: string; command: string; args_raw: string };
