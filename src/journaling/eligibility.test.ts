import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { assessEligibility, eligibleSince, loadWindow, PENDING_MAX_AGE_MS } from './eligibility.js';

let db: Database.Database;
let seq = 0;

function session(id = 's1') {
  db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, agent_id)
    VALUES (?, 'conv-1', 'telegram', 'chris', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'agent:baxter')`).run(id);
}

function row(opts: { at: string; dir?: 'inbound' | 'outbound'; contact?: string; body?: string; meta?: Record<string, unknown>; sessionId?: string }) {
  seq += 1;
  db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
    VALUES (?, ?, 'conv-1', ?, ?, 'telegram', ?, ?, ?, json(?))`).run(
    `t${seq}`, `m${seq}`, opts.sessionId ?? 's1', opts.at, opts.contact ?? 'chris', opts.dir ?? 'inbound', opts.body ?? `msg ${seq}`,
    JSON.stringify(opts.meta ?? {}),
  );
}

const T = (min: number) => new Date(Date.UTC(2026, 9, 1, 0, min)).toISOString();

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seq = 0;
  session();
});

describe('loadWindow (E66 S66.2)', () => {
  it('counts only human inbound: excludes scheduled, system-only, commands, replies to commands, agents and reactions', () => {
    row({ at: T(1), meta: { scheduled: true }, body: 'morning briefing trigger' });
    row({ at: T(2), meta: { system_only: true } });
    row({ at: T(3), body: '/status' });
    row({ at: T(4), dir: 'outbound', meta: { command_response: true }, body: 'status output' });
    row({ at: T(5), contact: 'agent:peggy', body: 'hi from peggy' });
    row({ at: T(6), contact: 'system:bus' });
    row({ at: T(7), body: '[reaction:added 👍 → x]' });
    const w = loadWindow(db, { sessionId: 's1', cursorAt: null, agentId: 'agent:baxter' });
    expect(w.humanTimes).toEqual([]);
    expect(w.messages).toEqual([]);
    expect(w.advanceTo).toBe(T(7));
  });

  it('starts the window at the last agent message before the first human message (scheduled-job reply)', () => {
    row({ at: T(1), meta: { scheduled: true }, body: 'run the briefing' });
    row({ at: T(2), dir: 'outbound', body: 'Here is your briefing' });
    row({ at: T(3), body: 'Move the 3pm meeting' });
    row({ at: T(4), body: '/status' });
    row({ at: T(5), dir: 'outbound', body: 'Done' });
    const w = loadWindow(db, { sessionId: 's1', cursorAt: null, agentId: 'agent:baxter', isOwner: (c) => c === 'chris' });
    expect(w.messages.map((m) => m.body)).toEqual(['Here is your briefing', 'Move the 3pm meeting', 'Done']);
    expect(w.messages[0]).toMatchObject({ context: true, direction: 'outbound', author: { id: 'agent:baxter', is_agent: true } });
    expect(w.messages[1]).toMatchObject({ context: false, author: { id: 'chris', is_human: true, is_owner: true } });
    expect(w.humanTimes).toEqual([T(3)]);
    expect(w).toMatchObject({ from: T(2), to: T(5), advanceTo: T(5) });
  });

  it('only sees content past the cursor, but keeps an earlier agent message as context', () => {
    row({ at: T(1), body: 'old' });
    row({ at: T(2), dir: 'outbound', body: 'old reply' });
    row({ at: T(3), body: 'new' });
    const w = loadWindow(db, { sessionId: 's1', cursorAt: T(2), agentId: 'agent:baxter' });
    expect(w.humanTimes).toEqual([T(3)]);
    expect(w.messages.map((m) => [m.body, m.context])).toEqual([['old reply', true], ['new', false]]);
  });

  it('passes attachments by path', () => {
    row({ at: T(1), meta: { attachments: [{ type: 'image', local_path: '/tmp/a.png', mime_type: 'image/png' }] } });
    const w = loadWindow(db, { sessionId: 's1', cursorAt: null, agentId: 'agent:baxter' });
    expect(w.messages[0]!.attachments).toEqual([{ type: 'image', path: '/tmp/a.png', mime_type: 'image/png' }]);
  });
});

describe('assessEligibility (E66 S66.2)', () => {
  const now = new Date(T(30));
  it('nothing without human content', () => {
    expect(assessEligibility({ humanTimes: [] }, { minHumanMessages: 2, trigger: 'clear', now })).toEqual({ kind: 'nothing' });
  });
  it('pending below min_human_messages for non-final triggers', () => {
    expect(assessEligibility({ humanTimes: [T(1)] }, { minHumanMessages: 2, trigger: 'pause', now }))
      .toEqual({ kind: 'pending', humanCount: 1, firstHumanAt: T(1) });
  });
  it('eligible at the threshold', () => {
    expect(assessEligibility({ humanTimes: [T(1), T(2)] }, { minHumanMessages: 2, trigger: 'ceiling', now }))
      .toMatchObject({ kind: 'eligible', reason: 'threshold' });
  });
  it('final triggers, a pending final trigger and manual bypass the threshold', () => {
    for (const trigger of ['close', 'clear', 'evict', 'release', 'pre-compact', 'session-end', 'shutdown'] as const) {
      expect(assessEligibility({ humanTimes: [T(1)] }, { minHumanMessages: 2, trigger, now })).toMatchObject({ reason: 'final' });
    }
    expect(assessEligibility({ humanTimes: [T(1)] }, { minHumanMessages: 2, trigger: 'pause', hasPendingFinal: true, now }))
      .toMatchObject({ reason: 'final' });
    expect(assessEligibility({ humanTimes: [T(1)] }, { minHumanMessages: 5, trigger: 'manual', now })).toMatchObject({ reason: 'manual' });
  });
  it('pending content older than 24 h is journaled anyway', () => {
    const later = new Date(new Date(T(1)).getTime() + PENDING_MAX_AGE_MS);
    expect(assessEligibility({ humanTimes: [T(1)] }, { minHumanMessages: 2, trigger: 'pause', now: later }))
      .toMatchObject({ kind: 'eligible', reason: 'aged' });
  });
});

describe('eligibleSince (backlog age, E66 S66.2)', () => {
  it('counts only content that met the threshold', () => {
    expect(eligibleSince({ humanTimes: [T(1)] }, { minHumanMessages: 2, now: new Date(T(30)) })).toBeNull();
    expect(eligibleSince({ humanTimes: [T(1), T(5), T(9)] }, { minHumanMessages: 2, now: new Date(T(30)) })).toBe(T(5));
  });
  it('pending content counts once it is 24 h old, and a pending final trigger counts from when it fired', () => {
    const later = new Date(new Date(T(1)).getTime() + PENDING_MAX_AGE_MS + 60_000);
    expect(eligibleSince({ humanTimes: [T(1)] }, { minHumanMessages: 2, now: later }))
      .toBe(new Date(new Date(T(1)).getTime() + PENDING_MAX_AGE_MS).toISOString());
    expect(eligibleSince({ humanTimes: [T(1)] }, { minHumanMessages: 2, pendingSince: T(10), now: new Date(T(30)) })).toBe(T(10));
  });
});
