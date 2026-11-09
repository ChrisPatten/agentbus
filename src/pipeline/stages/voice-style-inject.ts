/**
 * Stage 89 — Voice Style Inject (critical: false) (E102)
 *
 * A push-to-talk message (`metadata.input === "voice"`) is answered aloud, so the agent needs the
 * owner's voice style guide (`adapters.intercom.voice.speech.style_file`). The guide is long, so it
 * rides along ONCE per agent session: the first voice message a session receives, and again only
 * when the file's content hash differs from what that session was last given.
 *
 * Session identity is `<bus sessions.id>|<route recipient>`: `sessions.id` is replaced by a new row
 * whenever the conversation's session ends (`/clear`, an idle cut), and the recipient is the pool
 * pane for a cc-pool route, so a reset, a new session or a different pane all inject again. State
 * lives in `voice_style_injections`, so a bus-core restart does not re-inject into live panes.
 *
 * The file is read fresh from disk on every voice message (a few KB; edits take effect at once).
 * The block is a system block for that route's recipient only, rendered before the per-message
 * Intercom note. Limits: the bus cannot see Claude's own compaction, and marks the guide delivered
 * when the message is enqueued, not when the pane acks it (same as advisories).
 *
 * Runs after transcript-log (80), which sets `ctx.sessionId`; the block is never stored as text.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../../config/schema.js';
import type { PipelineStage } from '../types.js';
import { JOURNAL_RUN_KEY, attachSystemBlock, isSystemOnly, renderSystemBlock } from '../../core/system-block.js';

export const VOICE_STYLE_BLOCK_KIND = 'voice-style';
const KEEP_DAYS = 30;

/** The guide's text and content hash, or null when it is unset, unreadable or empty. */
export function readStyleGuide(path: string): { text: string; hash: string } | null {
  if (!path.trim()) return null;
  try {
    const text = readFileSync(path, 'utf-8').trim();
    if (!text) return null;
    return { text, hash: createHash('sha256').update(text).digest('hex') };
  } catch {
    return null;
  }
}

export function createVoiceStyleInject(db: Database.Database, config: AppConfig, log: (line: string) => void = (l) => console.warn(`[voice-style] ${l}`)): PipelineStage {
  let lastPrune = 0;
  return async (ctx) => {
    const meta = ctx.envelope.metadata ?? {};
    if (meta['input'] !== 'voice' || ctx.isSlashCommand) return ctx;
    if (isSystemOnly(meta) || meta[JOURNAL_RUN_KEY]) return ctx;
    const path = config.adapters.intercom?.voice.speech.style_file ?? '';
    if (!path) return ctx;
    const guide = readStyleGuide(path);
    if (!guide) { log(`style_file unreadable or empty: ${path}`); return ctx; }
    const sessionId = ctx.sessionId ?? ctx.conversationId;
    if (!sessionId) return ctx;
    const nowMs = Date.now();
    for (const route of ctx.routes) {
      if (!route.recipientId.startsWith('agent:')) continue;
      const key = `${sessionId}|${route.recipientId}`;
      const row = db.prepare('SELECT hash FROM voice_style_injections WHERE session_key = ?').get(key) as { hash: string } | undefined;
      if (row?.hash === guide.hash) continue;
      attachSystemBlock(ctx.envelope.metadata, renderSystemBlock(VOICE_STYLE_BLOCK_KIND, guide.text), route.recipientId);
      db.prepare(
        `INSERT INTO voice_style_injections (session_key, hash, injected_at) VALUES (?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET hash = excluded.hash, injected_at = excluded.injected_at`,
      ).run(key, guide.hash, new Date(nowMs).toISOString());
    }
    if (nowMs - lastPrune > 3_600_000) {
      lastPrune = nowMs;
      db.prepare('DELETE FROM voice_style_injections WHERE injected_at < ?').run(new Date(nowMs - KEEP_DAYS * 86_400_000).toISOString());
    }
    return ctx;
  };
}
