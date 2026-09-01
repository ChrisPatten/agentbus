import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import type { SlashCommandContext } from './registry.js';
import { createCostCommand, resolveAgentId, startOfToday, startOfWeek, startOfMonth } from './cost.js';
import { createSafeDatabase } from '../db/safe-database.js';
import type { MessageEnvelope } from '../types/envelope.js';
import type { AppConfig } from '../config/schema.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertSession(db: Database.Database, opts: { id: string; channel?: string; agentId?: string | null }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, ended_at, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(opts.id, `conv-${opts.id}`, opts.channel ?? 'telegram', 'chris', now, now, opts.agentId ?? null);
}

function insertCost(db: Database.Database, opts: { agentId: string | null; ts: string; costUsd: number }) {
  db.prepare(
    `INSERT INTO turn_costs (agent_id, session_id, ts, cost_usd) VALUES (?, NULL, ?, ?)`,
  ).run(opts.agentId, opts.ts, opts.costUsd);
}

function makeEnvelope(): MessageEnvelope {
  return {
    id: 'test-id',
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'contact:chris',
    recipient: 'agent:peggy',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: '/cost' },
    metadata: {},
  };
}

function makeCtx(db: Database.Database, overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    channel: 'telegram',
    sender: 'contact:chris',
    adapterId: 'telegram',
    argsRaw: '',
    envelope: makeEnvelope(),
    db: createSafeDatabase(db),
    config: {} as unknown as AppConfig,
    ...overrides,
  };
}

describe('resolveAgentId (/cost — same resolution shape as /stop)', () => {
  it('uses the active sessions agent_id when present', () => {
    const db = makeDb();
    insertSession(db, { id: 'sess-1', agentId: 'agent:peggy' });
    const result = resolveAgentId({ db }, makeCtx(db));
    expect(result).toBe('agent:peggy');
  });

  it('falls back to the sole registered instance when the session predates agent_id tracking', () => {
    const db = makeDb();
    insertSession(db, { id: 'sess-legacy', agentId: null });
    const result = resolveAgentId(
      { db, headlessControl: { journalResumeId: new Map(), stopTurn: new Map([['agent:peggy', () => true]]) } },
      makeCtx(db),
    );
    expect(result).toBe('agent:peggy');
  });

  it('returns null when there is no active session and no unambiguous fallback', () => {
    const db = makeDb();
    const result = resolveAgentId({ db }, makeCtx(db));
    expect(result).toBeNull();
  });

  it('returns null when multiple instances are registered and no session resolves the agent', () => {
    const db = makeDb();
    const result = resolveAgentId(
      {
        db,
        headlessControl: {
          journalResumeId: new Map(),
          stopTurn: new Map([
            ['agent:peggy', () => true],
            ['agent:pokeclaude', () => true],
          ]),
        },
      },
      makeCtx(db),
    );
    expect(result).toBeNull();
  });
});

describe('day/week/month range helpers (local-midnight boundary)', () => {
  it('startOfToday strips time down to local midnight', () => {
    const now = new Date(2026, 2, 15, 23, 59, 59); // 2026-03-15 23:59:59 local
    expect(startOfToday(now)).toEqual(new Date(2026, 2, 15, 0, 0, 0, 0));
  });

  it('startOfWeek is exactly 7*24h before now', () => {
    const now = new Date(2026, 2, 15, 12, 0, 0);
    expect(startOfWeek(now).getTime()).toBe(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  it('startOfMonth is the 1st of the current month at local midnight', () => {
    const now = new Date(2026, 2, 15, 12, 0, 0);
    expect(startOfMonth(now)).toEqual(new Date(2026, 2, 1, 0, 0, 0, 0));
  });
});

describe('/cost command', () => {
  it('reports "could not determine" when no agent can be resolved', async () => {
    const db = makeDb();
    const cmd = createCostCommand({ db });

    const result = await cmd.handler([], makeCtx(db));

    expect(result.body).toContain('Could not determine');
  });

  it('sums day/week/month cost scoped to the resolved agent only', async () => {
    const db = makeDb();
    insertSession(db, { id: 'sess-1', agentId: 'agent:peggy' });
    const now = new Date(2026, 2, 15, 10, 0, 0); // 2026-03-15 10:00 local

    insertCost(db, { agentId: 'agent:peggy', ts: new Date(2026, 2, 15, 1, 0, 0).toISOString(), costUsd: 1 }); // today
    insertCost(db, { agentId: 'agent:peggy', ts: new Date(2026, 2, 10, 1, 0, 0).toISOString(), costUsd: 2 }); // this week, not today
    insertCost(db, { agentId: 'agent:peggy', ts: new Date(2026, 2, 3, 1, 0, 0).toISOString(), costUsd: 4 }); // this month, not this week
    insertCost(db, { agentId: 'agent:peggy', ts: new Date(2026, 1, 1, 1, 0, 0).toISOString(), costUsd: 8 }); // outside every window
    insertCost(db, { agentId: 'agent:pokeclaude', ts: new Date(2026, 2, 15, 1, 0, 0).toISOString(), costUsd: 99 }); // different agent

    const cmd = createCostCommand({ db, now: () => now });
    const result = await cmd.handler([], makeCtx(db));

    expect(result.body).toBe('Today: $1.00\nThis week: $3.00\nThis month: $7.00');
  });

  it('excludes a row from "today" that falls just before local midnight (boundary case)', async () => {
    const db = makeDb();
    insertSession(db, { id: 'sess-1', agentId: 'agent:peggy' });
    const now = new Date(2026, 2, 15, 0, 30, 0); // 2026-03-15 00:30 local — just after midnight
    const midnight = startOfToday(now);
    const justBeforeMidnight = new Date(midnight.getTime() - 1);

    insertCost(db, { agentId: 'agent:peggy', ts: justBeforeMidnight.toISOString(), costUsd: 5 });
    insertCost(db, { agentId: 'agent:peggy', ts: midnight.toISOString(), costUsd: 3 });

    const cmd = createCostCommand({ db, now: () => now });
    const result = await cmd.handler([], makeCtx(db));

    // The pre-midnight row still counts for the week/month, but not "today".
    expect(result.body).toBe('Today: $3.00\nThis week: $8.00\nThis month: $8.00');
  });
});
