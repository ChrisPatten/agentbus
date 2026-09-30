import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import { getCcHeadlessInstances } from '../config/schema.js';
import { claudeTranscriptExists } from '../adapters/claude-transcript.js';

export function sessionCanResume(db: Database.Database, config: AppConfig, sessionId: string,
  transcriptExists: (claudeId: string, cwd: string) => boolean = claudeTranscriptExists): boolean {
  const row = db.prepare('SELECT agent_id, claude_session_id FROM sessions WHERE id = ?')
    .get(sessionId) as {agent_id:string|null;claude_session_id:string|null}|undefined;
  if (!row?.agent_id || !row.claude_session_id) return false;
  const instance = getCcHeadlessInstances(config).find(i => `agent:${i.agent_id}` === row.agent_id);
  return !!instance && transcriptExists(row.claude_session_id, instance.working_dir ?? process.cwd());
}
