import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { writeKnowledge, getKnowledge, forgetKnowledge, searchKnowledge } from './store.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('writeKnowledge', () => {
  it('computes content_hash deterministically from the flattened payload text', () => {
    const db = makeDb();

    const a = writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'First',
      payload: JSON.stringify({ text: 'hello world', nested: { more: 'text here' } }),
    });
    const b = writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'Second, same content',
      payload: JSON.stringify({ text: 'hello world', nested: { more: 'text here' } }),
    });

    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const row = getKnowledge(db, a.id)!;
    // "hello world" then "text here" in traversal order, joined with '\n'
    expect(row.body_text).toBe('hello world\ntext here');
  });

  it('rejects a payload that is not valid JSON', () => {
    const db = makeDb();
    expect(() =>
      writeKnowledge(db, {
        agent_id: 'peggy',
        kind: 'note',
        title: 'Bad',
        payload: '{not json',
      }),
    ).toThrow(/valid JSON/);
  });

  it('with supersedes marks the old row superseded_by the new id', () => {
    const db = makeDb();
    const first = writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'fact',
      title: 'Old fact',
      payload: JSON.stringify({ v: 'one' }),
    });

    const second = writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'fact',
      title: 'New fact',
      payload: JSON.stringify({ v: 'two' }),
      supersedes: first.id,
    });

    expect(second.supersededId).toBe(first.id);

    const oldRow = db.prepare('SELECT superseded_by FROM knowledge WHERE id = ?').get(first.id) as {
      superseded_by: string | null;
    };
    expect(oldRow.superseded_by).toBe(second.id);
  });

  it('stores tags and facets as JSON, defaulting to [] and {}', () => {
    const db = makeDb();
    const withDefaults = writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'No tags',
      payload: JSON.stringify({ v: 'x' }),
    });
    const row = getKnowledge(db, withDefaults.id)!;
    expect(JSON.parse(row.tags)).toEqual([]);
    expect(JSON.parse(row.facets)).toEqual({});

    const withTags = writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'Tagged',
      payload: JSON.stringify({ v: 'y' }),
      tags: ['a', 'b'],
      facets: { project: 'agentbus' },
    });
    const row2 = getKnowledge(db, withTags.id)!;
    expect(JSON.parse(row2.tags)).toEqual(['a', 'b']);
    expect(JSON.parse(row2.facets)).toEqual({ project: 'agentbus' });
  });
});

describe('getKnowledge', () => {
  it('returns undefined for a missing id', () => {
    const db = makeDb();
    expect(getKnowledge(db, 'nope')).toBeUndefined();
  });

  it('bumps recall_count and sets last_recalled_at on each call', () => {
    const db = makeDb();
    const { id } = writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'Recall me',
      payload: JSON.stringify({ v: 'x' }),
    });

    const first = getKnowledge(db, id)!;
    expect(first.recall_count).toBe(1);
    expect(first.last_recalled_at).not.toBeNull();

    const second = getKnowledge(db, id)!;
    expect(second.recall_count).toBe(2);
  });
});

describe('forgetKnowledge', () => {
  it('mode "supersede" sets superseded_by and requires opts.supersededBy', () => {
    const db = makeDb();
    const { id } = writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'To supersede',
      payload: JSON.stringify({ v: 'x' }),
    });

    expect(() => forgetKnowledge(db, id, 'supersede')).toThrow(/supersededBy/);

    forgetKnowledge(db, id, 'supersede', { supersededBy: 'other-id' });
    const row = db.prepare('SELECT superseded_by FROM knowledge WHERE id = ?').get(id) as {
      superseded_by: string | null;
    };
    expect(row.superseded_by).toBe('other-id');
  });

  it('mode "expire" sets expires_at to now', () => {
    const db = makeDb();
    const { id } = writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'To expire',
      payload: JSON.stringify({ v: 'x' }),
    });

    forgetKnowledge(db, id, 'expire');
    const row = db.prepare('SELECT expires_at FROM knowledge WHERE id = ?').get(id) as {
      expires_at: string | null;
    };
    expect(row.expires_at).not.toBeNull();
  });

  it('mode "delete" hard-deletes the row', () => {
    const db = makeDb();
    const { id } = writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'To delete',
      payload: JSON.stringify({ v: 'x' }),
    });

    forgetKnowledge(db, id, 'delete');
    expect(getKnowledge(db, id)).toBeUndefined();
  });
});

describe('searchKnowledge', () => {
  it('matches with q via FTS', () => {
    const db = makeDb();
    writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'Great espresso place',
      payload: JSON.stringify({ text: 'unrelated content' }),
    });
    writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'Unrelated',
      payload: JSON.stringify({ text: 'nothing to do with the query' }),
    });

    const { results, count } = searchKnowledge(db, { agent_id: 'peggy', q: 'espresso' });
    expect(count).toBe(1);
    expect(results[0]?.title).toBe('Great espresso place');
  });

  it('filters by kind', () => {
    const db = makeDb();
    writeKnowledge(db, { agent_id: 'peggy', kind: 'contact', title: 'A', payload: '{}' });
    writeKnowledge(db, { agent_id: 'peggy', kind: 'project', title: 'B', payload: '{}' });

    const { results } = searchKnowledge(db, { agent_id: 'peggy', kind: 'project' });
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('B');
  });

  it('filters by tags, requiring all given tags to be present', () => {
    const db = makeDb();
    writeKnowledge(db, { agent_id: 'peggy', kind: 'note', title: 'AB', payload: '{}', tags: ['a', 'b'] });
    writeKnowledge(db, { agent_id: 'peggy', kind: 'note', title: 'A only', payload: '{}', tags: ['a'] });

    const { results } = searchKnowledge(db, { agent_id: 'peggy', tags: ['a', 'b'] });
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('AB');
  });

  it('filters by facets with exact match', () => {
    const db = makeDb();
    writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'Match',
      payload: '{}',
      facets: { project: 'agentbus' },
    });
    writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'No match',
      payload: '{}',
      facets: { project: 'other' },
    });

    const { results } = searchKnowledge(db, { agent_id: 'peggy', facets: { project: 'agentbus' } });
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Match');
  });

  it('filters by event_from/event_to, keeping rows with a null event_at', () => {
    const db = makeDb();
    writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'In range',
      payload: '{}',
      event_at: '2026-06-15T00:00:00Z',
    });
    writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'Out of range',
      payload: '{}',
      event_at: '2020-01-01T00:00:00Z',
    });
    writeKnowledge(db, {
      agent_id: 'peggy',
      kind: 'note',
      title: 'No event_at',
      payload: '{}',
    });

    const { results } = searchKnowledge(db, {
      agent_id: 'peggy',
      event_from: '2026-01-01T00:00:00Z',
      event_to: '2026-12-31T00:00:00Z',
    });
    const titles = results.map((r) => r.title).sort();
    expect(titles).toEqual(['In range', 'No event_at']);
  });

  it('excludes superseded and expired rows', () => {
    const db = makeDb();
    const first = writeKnowledge(db, { agent_id: 'peggy', kind: 'note', title: 'Old', payload: '{}' });
    writeKnowledge(db, { agent_id: 'peggy', kind: 'note', title: 'New', payload: '{}', supersedes: first.id });
    const expired = writeKnowledge(db, { agent_id: 'peggy', kind: 'note', title: 'Expiring', payload: '{}' });
    forgetKnowledge(db, expired.id, 'expire');

    const { results } = searchKnowledge(db, { agent_id: 'peggy' });
    const titles = results.map((r) => r.title).sort();
    expect(titles).toEqual(['New']);
  });

  it('respects limit', () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      writeKnowledge(db, { agent_id: 'peggy', kind: 'note', title: `Row ${i}`, payload: '{}' });
    }

    const { results, count } = searchKnowledge(db, { agent_id: 'peggy', limit: 2 });
    expect(results).toHaveLength(2);
    expect(count).toBe(2);
  });
});
