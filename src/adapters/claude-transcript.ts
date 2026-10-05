import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The Claude Code project path convention shared by pool and app resume. */
export function claudeTranscriptPath(sessionId: string, cwd: string, home = homedir()): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return join(home, '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

export function claudeTranscriptExists(sessionId: string, cwd: string): boolean {
  return existsSync(claudeTranscriptPath(sessionId, cwd));
}
