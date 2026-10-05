import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import type { AppConfig } from '../config/schema.js';
import { claudeTranscriptPath } from '../adapters/claude-transcript.js';
import { sessionCanResume } from './resume.js';

describe('Earlier Claude transcript discovery', () => {
  it('uses the same cwd slug as Claude Code projects', () => {
    expect(claudeTranscriptPath('abc', '/Users/me/work project', '/home/me'))
      .toBe('/home/me/.claude/projects/-Users-me-work-project/abc.jsonl');
  });

  it('requires a matching headless owner, Claude ID, and on-disk transcript', () => {
    const db = new Database(':memory:'); runMigrations(db);
    const config = { adapters: { 'cc-headless': { agent_id: 'work', working_dir: '/work/dir', system_prompt: 'test' } } } as unknown as AppConfig;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`)
      .run('conv', 'alice', 'telegram', 'general', now, now);
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,agent_id,claude_session_id)
      VALUES (?,?,?,?,?,?,?,?)`).run('session', 'conv', 'telegram', 'alice', now, now, 'agent:work', 'claude-id');
    const check = vi.fn(() => true);
    expect(sessionCanResume(db, config, 'session', check)).toBe(true);
    expect(check).toHaveBeenCalledWith('claude-id', '/work/dir');
    expect(sessionCanResume(db, config, 'session', () => false)).toBe(false);
    db.prepare('UPDATE sessions SET agent_id = ? WHERE id = ?').run('agent:other', 'session');
    expect(sessionCanResume(db, config, 'session', check)).toBe(false);
    db.close();
  });
});
