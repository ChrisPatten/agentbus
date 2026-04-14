import type Database from 'better-sqlite3';
import type { MessageEnvelope } from '../types/envelope.js';
import type { AppConfig } from '../config/schema.js';

/** Resolved contact info attached during contact-resolve stage */
export interface ResolvedContact {
  id: string;
  displayName: string;
  platforms: Record<string, unknown>;
}

/** Parsed slash command info attached during slash-command detect stage */
export interface SlashCommandInfo {
  name: string;
  args: string[];
  argsRaw: string;
}

/** A resolved route target for enqueue */
export interface RouteTarget {
  adapterId: string;
  recipientId: string;
}

/** The mutable context that flows through all pipeline stages */
export interface PipelineContext {
  /** The envelope being built/enriched */
  envelope: MessageEnvelope;
  /** Resolved contact (null if unknown sender) */
  contact: ResolvedContact | null;
  /** Dedup key computed by dedup stage */
  dedupKey: string | null;
  /** Whether this message is a slash command */
  isSlashCommand: boolean;
  /** Parsed slash command info */
  slashCommand: SlashCommandInfo | null;
  /** Classified topics from topic-classify stage */
  topics: string[];
  /** Numeric priority score (0–100) from priority-score stage */
  priorityScore: number;
  /** Resolved route targets from route-resolve stage */
  routes: RouteTarget[];
  /** Conversation ID (sha256 hash) computed during route-resolve */
  conversationId: string | null;
  /** Session ID for transcript logging */
  sessionId: string | null;
  /** Whether Stage 80 created a brand-new session (vs. extending an existing one) */
  sessionCreated: boolean;
  /** Reason the pipeline was aborted (set by the stage returning null) */
  abortReason?: string;
  /** Infrastructure references — stages read these, never mutate */
  config: AppConfig;
  db: Database.Database;
}

/** A pipeline stage: pure async function that transforms context */
export type PipelineStage = (ctx: PipelineContext) => Promise<PipelineContext | null>;

/** Registration record for a stage in the engine */
export interface PipelineStageDefinition {
  name: string;
  /** Execution slot — lower numbers run first (10, 20, 30, … 80) */
  slot: number;
  stage: PipelineStage;
  /** If false, errors in this stage are logged but don't abort. Default: true */
  critical?: boolean;
}
