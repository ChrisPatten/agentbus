import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import { claudeTranscriptExists } from '../adapters/claude-transcript.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';

/**
 * Whether an Earlier session can be branched into a new app session: its
 * runtime supports `sessionFork` (cc-headless today) and the Claude transcript
 * is still on disk (E64 live check).
 */
export function sessionCanResume(db: Database.Database, config: AppConfig, sessionId: string,
  transcriptExists: (claudeId: string, cwd: string) => boolean = claudeTranscriptExists): boolean {
  const row = db.prepare('SELECT agent_id, claude_session_id FROM sessions WHERE id = ?')
    .get(sessionId) as {agent_id:string|null;claude_session_id:string|null}|undefined;
  if (!row?.agent_id || !row.claude_session_id) return false;
  return new RuntimeResolver(config, { transcriptExists })
    .checkLive('sessionFork', { agentId: row.agent_id, claudeSessionId: row.claude_session_id }).ok;
}
