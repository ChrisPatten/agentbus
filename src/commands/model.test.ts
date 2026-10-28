import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { createSafeDatabase } from '../db/safe-database.js';
import type { SlashCommandContext } from './registry.js';
import type { MessageEnvelope } from '../types/envelope.js';
import type { AppConfig } from '../config/schema.js';
import { createModelCommand, resolveTarget } from './model.js';
import type { PoolManager } from '../pool/pool-manager.js';
import { vi } from 'vitest';
import { setModelOverride } from '../adapters/model-override-loader.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeConfig(opts: { poolModel?: string; routes?: unknown[]; catalog?: unknown[] } = {}): AppConfig {
  return {
    adapters: {
      'cc-pool': {
        pokeclaude: {
          agent_id: 'pokeclaude',
          tmux_session: 'pokeclaude',
          panes: 2,
          growth: 'fixed',
          ...(opts.poolModel ? { model: opts.poolModel } : {}),
        },
      },
      'cc-headless': {
        peggy: { agent_id: 'peggy', system_prompt: 'x', model: 'sonnet' },
      },
    },
    pipeline: { routes: opts.routes ?? [], drop_unrouted: false },
    ...(opts.catalog ? { models: { catalog: opts.catalog } } : {}),
  } as unknown as AppConfig;
}

const POOL_ROUTE = [{ adapterId: 'cc-pool', recipientId: 'agent:pokeclaude-pool-1' }];

function makeCtx(
  db: Database.Database,
  config: AppConfig,
  routes: SlashCommandContext['routes'] = POOL_ROUTE,
): SlashCommandContext {
  const envelope: MessageEnvelope = {
    id: 'test-id',
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'contact:chris',
    recipient: 'agent:pokeclaude',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: '/model' },
    metadata: {},
  };
  return {
    channel: 'telegram',
    sender: 'contact:chris',
    adapterId: 'telegram',
    argsRaw: '',
    envelope,
    db: createSafeDatabase(db),
    config,
    routes,
  };
}

function override(db: Database.Database, agentId: string): string | undefined {
  const row = db.prepare(`SELECT model FROM model_overrides WHERE agent_id = ?`).get(agentId) as
    | { model: string }
    | undefined;
  return row?.model;
}

async function run(db: Database.Database, config: AppConfig, args: string[], routes?: SlashCommandContext['routes']) {
  return createModelCommand({ db }).handler(args, makeCtx(db, config, routes));
}

describe('resolveTarget', () => {
  const config = makeConfig({ poolModel: 'claude-sonnet-5' });

  it('maps a pool pane, the pool id, and the parked bucket to the pool agent', () => {
    for (const recipientId of ['agent:pokeclaude-pool-3', 'agent:pokeclaude', 'agent:pokeclaude__parked']) {
      expect(resolveTarget([{ adapterId: 'cc-pool', recipientId }], config)).toEqual({
        agentId: 'agent:pokeclaude',
        name: 'Pokeclaude',
        configModel: 'claude-sonnet-5',
        poolId: 'pokeclaude',
      });
    }
  });

  it('maps a cc-headless route to its instance', () => {
    expect(resolveTarget([{ adapterId: 'cc-headless', recipientId: 'agent:peggy' }], config)).toEqual({
      agentId: 'agent:peggy',
      name: 'Peggy',
      configModel: 'sonnet',
    });
  });

  it('skips claude-code and unknown recipients', () => {
    expect(resolveTarget([{ adapterId: 'claude-code', recipientId: 'agent:claude' }], config)).toBeNull();
    expect(resolveTarget([{ adapterId: 'cc-pool', recipientId: 'agent:other-pool-1' }], config)).toBeNull();
    expect(resolveTarget(undefined, config)).toBeNull();
  });
});

describe('/model', () => {
  it('no args: reports current model and source, with a picker', async () => {
    const db = makeDb();
    const res = await run(db, makeConfig({ poolModel: 'claude-sonnet-5-5' }), []);
    expect(res.body).toBe('Pokeclaude is on Sonnet 5.5 (claude-sonnet-5-5) — from config.');
    expect(res.choices).toEqual([
      { label: 'Fable 5.1', args: 'claude-fable-5-1' },
      { label: 'Opus 5.5', args: 'claude-opus-5-5' },
      { label: 'Sonnet 5.5 (current)', args: 'claude-sonnet-5-5' },
      { label: 'Haiku 5.5', args: 'claude-haiku-5-5' },
    ]);
  });

  it('no args: shows an alias as-is and says CLI default when nothing is configured', async () => {
    const db = makeDb();
    const alias = await run(db, makeConfig({ poolModel: 'sonnet' }), []);
    expect(alias.body).toBe('Pokeclaude is on sonnet — from config.');
    const none = await run(db, makeConfig(), []);
    expect(none.body).toBe('Pokeclaude is on the CLI default — no model configured.');
  });

  it('no args: adds a reset choice when an agent override exists', async () => {
    const db = makeDb();
    setModelOverride(db, 'claude-opus-5-5', 'agent:pokeclaude');
    const res = await run(db, makeConfig({ poolModel: 'claude-sonnet-5' }), []);
    expect(res.body).toBe('Pokeclaude is on Opus 5.5 (claude-opus-5-5) — set with /model.');
    expect(res.choices).toContainEqual({ label: 'Opus 5.5 (current)', args: 'claude-opus-5-5' });
    expect(res.choices!.at(-1)).toEqual({ label: 'Reset to config (claude-sonnet-5)', args: 'reset' });
  });

  it('no args: reports a global override as such, with no reset choice', async () => {
    const db = makeDb();
    setModelOverride(db, 'claude-haiku-5-5', null);
    const res = await run(db, makeConfig({ poolModel: 'claude-sonnet-5' }), []);
    expect(res.body).toBe('Pokeclaude is on Haiku 5.5 (claude-haiku-5-5) — global override.');
    expect(res.choices!.some((c) => c.args === 'reset')).toBe(false);
  });

  it('`opus` sets the latest Opus id', async () => {
    const db = makeDb();
    const res = await run(db, makeConfig(), ['opus']);
    expect(res.body).toBe('Pokeclaude → Opus 5.5 (claude-opus-5-5). Takes effect on the next message.');
    expect(override(db, 'agent:pokeclaude')).toBe('claude-opus-5-5');
  });

  it('`haiku 4.5` sets that exact version', async () => {
    const db = makeDb();
    await run(db, makeConfig(), ['haiku', '4.5']);
    expect(override(db, 'agent:pokeclaude')).toBe('claude-haiku-4-5');
  });

  it('`haiku 5.1` errors with suggestion choices and writes nothing', async () => {
    const db = makeDb();
    const res = await run(db, makeConfig(), ['haiku', '5.1']);
    expect(res.body).toBe('No Haiku 5.1 — known: 5.5');
    expect(res.choices).toEqual([{ label: 'Haiku 5.5', args: 'claude-haiku-5-5' }]);
    expect(override(db, 'agent:pokeclaude')).toBeUndefined();
  });

  it('an unknown claude- id is accepted with a warning', async () => {
    const db = makeDb();
    const res = await run(db, makeConfig(), ['claude-foo-9']);
    expect(res.body).toBe(
      'Pokeclaude → claude-foo-9. Takes effect on the next message.\n' +
        "Warning: claude-foo-9 isn't in the model catalog — check the id. /model list shows known models.",
    );
    expect(override(db, 'agent:pokeclaude')).toBe('claude-foo-9');
  });

  it('says "already on" when the override already equals the id', async () => {
    const db = makeDb();
    setModelOverride(db, 'claude-opus-5-5', 'agent:pokeclaude');
    const res = await run(db, makeConfig(), ['opus']);
    expect(res.body).toBe('Pokeclaude is already on Opus 5.5 (claude-opus-5-5).');
  });

  it('`reset` removes the override and reports the fallback', async () => {
    const db = makeDb();
    setModelOverride(db, 'claude-opus-5-5', 'agent:pokeclaude');
    const res = await run(db, makeConfig({ poolModel: 'claude-sonnet-5' }), ['reset']);
    expect(res.body).toBe(
      'Override removed. Pokeclaude is now on Sonnet 5 (claude-sonnet-5) — from config. Takes effect on the next message.',
    );
    expect(override(db, 'agent:pokeclaude')).toBeUndefined();

    const again = await run(db, makeConfig({ poolModel: 'claude-sonnet-5' }), ['default']);
    expect(again.body).toBe('No /model override to remove. Pokeclaude is on Sonnet 5 (claude-sonnet-5) — from config.');
  });

  it('`list` groups the catalog by family and tags deprecated and current', async () => {
    const db = makeDb();
    const res = await run(db, makeConfig({ poolModel: 'claude-sonnet-5' }), ['list']);
    expect(res.choices).toBeUndefined();
    expect(res.body).toBe(
      [
        'Known models:',
        'Fable',
        '  Fable 5.1 — claude-fable-5-1',
        'Opus',
        '  Opus 5.5 — claude-opus-5-5',
        '  Opus 5 — claude-opus-5 (deprecated)',
        'Sonnet',
        '  Sonnet 5.5 — claude-sonnet-5-5',
        '  Sonnet 5 — claude-sonnet-5 (deprecated, current)',
        '  Sonnet 4.6 — claude-sonnet-4-6 (deprecated)',
        'Haiku',
        '  Haiku 5.5 — claude-haiku-5-5',
        '  Haiku 4.5 — claude-haiku-4-5 (deprecated)',
      ].join('\n'),
    );
  });

  it('includes config catalog entries', async () => {
    const db = makeDb();
    const config = makeConfig({
      catalog: [{ id: 'claude-opus-6', family: 'opus', version: '6', label: 'Opus 6' }],
    });
    await run(db, config, ['opus']);
    expect(override(db, 'agent:pokeclaude')).toBe('claude-opus-6');
  });

  it('refuses an unrouted chat and a claude-code route', async () => {
    const db = makeDb();
    const msg = "This chat isn't routed to an agent whose model I can change.";
    expect((await run(db, makeConfig(), [], [])).body).toBe(msg);
    expect((await run(db, makeConfig(), ['opus'], [{ adapterId: 'claude-code', recipientId: 'agent:claude' }])).body).toBe(msg);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM model_overrides`).get()).toEqual({ n: 0 });
  });

  it('works for a cc-headless agent', async () => {
    const db = makeDb();
    const routes = [{ adapterId: 'cc-headless', recipientId: 'agent:peggy' }];
    expect((await run(db, makeConfig(), [], routes)).body).toBe('Peggy is on sonnet — from config.');
    await run(db, makeConfig(), ['haiku'], routes);
    expect(override(db, 'agent:peggy')).toBe('claude-haiku-5-5');
  });

  it('notes active schedules routed to this agent that set their own model', async () => {
    const db = makeDb();
    const insert = db.prepare(
      `INSERT INTO scheduled_items (id, type, fire_at, channel, sender, payload_body, created_at, model, status)
       VALUES (?, 'once', '2030-01-01T00:00:00Z', ?, 'contact:chris', 'x', '2026-01-01T00:00:00Z', ?, ?)`,
    );
    insert.run('s1', 'telegram', 'claude-haiku-4-5', 'active');
    insert.run('s2', 'telegram', 'claude-opus-5-5', 'active');
    insert.run('s3', 'telegram', null, 'active'); // no model of its own
    insert.run('s4', 'telegram', 'claude-opus-5-5', 'cancelled'); // inactive
    insert.run('s5', 'email', 'claude-opus-5-5', 'active'); // routed elsewhere
    const config = makeConfig({
      routes: [
        { match: { channel: 'telegram' }, target: { adapterId: 'cc-pool', recipientId: 'agent:pokeclaude' } },
        { match: {}, target: { adapterId: 'cc-headless', recipientId: 'agent:peggy' } },
      ],
    });
    const res = await run(db, config, []);
    expect(res.body).toBe(
      "Pokeclaude is on the CLI default — no model configured.\nNote: 2 scheduled jobs set their own model and aren't affected.",
    );
  });
});

describe('/model — live cc-pool pane (E54 S54.3)', () => {
  function fakeManager(outcome: unknown) {
    const applyModelNow = vi.fn(async () => outcome);
    return { manager: { poolId: 'pokeclaude', applyModelNow } as unknown as PoolManager, applyModelNow };
  }
  const runWith = (db: Database.Database, poolManagers: Map<string, PoolManager>, args: string[], routes?: SlashCommandContext['routes']) =>
    createModelCommand({ db, poolManagers }).handler(args, makeCtx(db, makeConfig(), routes));

  it('applies the change to the live pane and says the pane was relaunched', async () => {
    const db = makeDb();
    const { manager, applyModelNow } = fakeManager({ status: 'switched', paneId: 'pokeclaude-pool:1', model: 'claude-opus-5-5' });
    const res = await runWith(db, new Map([['pokeclaude', manager]]), ['opus']);
    expect(override(db, 'agent:pokeclaude')).toBe('claude-opus-5-5');
    expect(applyModelNow).toHaveBeenCalledTimes(1);
    expect(applyModelNow.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ contact_id: 'chris', channel: 'telegram' })]);
    expect(res.body).toContain('Relaunched pokeclaude-pool:1 on the new model.');
  });

  it('reports a failed switch plainly while keeping the override', async () => {
    const db = makeDb();
    const { manager } = fakeManager({ status: 'failed', paneId: 'p:1', reason: 'the model confirmation prompt was still showing' });
    const res = await runWith(db, new Map([['pokeclaude', manager]]), ['opus']);
    expect(override(db, 'agent:pokeclaude')).toBe('claude-opus-5-5');
    expect(res.body).toContain('switching the live pane failed (the model confirmation prompt was still showing)');
    expect(res.body).toContain('fresh pane on the new model');
  });

  it('mentions a deferred switch and falls back to the next-message wording for no-pane', async () => {
    const db = makeDb();
    const deferred = await runWith(db, new Map([['pokeclaude', fakeManager({ status: 'deferred' }).manager]]), ['opus']);
    expect(deferred.body).toContain('A turn is in progress');
    const db2 = makeDb();
    const none = await runWith(db2, new Map([['pokeclaude', fakeManager({ status: 'no-pane' }).manager]]), ['opus']);
    expect(none.body).toContain('Takes effect on the next message.');
  });

  it('`reset` also applies to the live pane', async () => {
    const db = makeDb();
    setModelOverride(db, 'claude-opus-5-5', 'agent:pokeclaude');
    const { manager, applyModelNow } = fakeManager({ status: 'switched', paneId: 'p:1', model: 'x' });
    const res = await runWith(db, new Map([['pokeclaude', manager]]), ['reset']);
    expect(applyModelNow).toHaveBeenCalledTimes(1);
    expect(res.body).toContain('Override removed.');
    expect(res.body).toContain('Relaunched p:1');
  });

  it('never touches a pool for a cc-headless agent, or when no manager is wired', async () => {
    const db = makeDb();
    const { manager, applyModelNow } = fakeManager({ status: 'switched', paneId: 'p:1', model: 'x' });
    const res = await runWith(db, new Map([['pokeclaude', manager]]), ['opus'], [{ adapterId: 'cc-headless', recipientId: 'agent:peggy' }]);
    expect(applyModelNow).not.toHaveBeenCalled();
    expect(override(db, 'agent:peggy')).toBe('claude-opus-5-5');
    expect(res.body).toContain('Takes effect on the next message.');

    const bare = await createModelCommand({ db: makeDb() }).handler(['opus'], makeCtx(makeDb(), makeConfig()));
    expect(bare.body).toContain('Takes effect on the next message.');
  });

  it('does not touch the pool when the override is unchanged ("already on")', async () => {
    const db = makeDb();
    setModelOverride(db, 'claude-opus-5-5', 'agent:pokeclaude');
    const { manager, applyModelNow } = fakeManager({ status: 'switched', paneId: 'p:1', model: 'x' });
    await runWith(db, new Map([['pokeclaude', manager]]), ['opus']);
    expect(applyModelNow).not.toHaveBeenCalled();
  });
});

describe('/model — picker fits E74 limits', () => {
  it('caps choices at 8 and clips labels to 64 characters, keeping Reset', async () => {
    const db = makeDb();
    setModelOverride(db, 'claude-opus-5-5', 'agent:pokeclaude');
    const catalog = Array.from({ length: 12 }, (_, i) => ({
      id: `claude-x-${i}`,
      family: `fam${i}`,
      version: '1',
      label: `${'Very long label '.repeat(6)}${i}`,
    }));
    const res = await run(db, makeConfig({ catalog }), []);
    expect(res.choices!.length).toBeLessThanOrEqual(8);
    expect(res.choices!.at(-1)).toMatchObject({ args: 'reset' });
    for (const c of res.choices!) expect(c.label.length).toBeLessThanOrEqual(64);
  });
});
