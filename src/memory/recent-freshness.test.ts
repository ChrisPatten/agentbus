import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { RecentMemory } from './recent-service.js';
import { RecentFreshness, parseFreshnessQuery, recentDelta } from './recent-freshness.js';

let dir: string;
let db: Database.Database;
let now: Date;

function build(resolveAgent: (id: string) => string | null = (id) => (id.startsWith('pane-') ? 'agent:peggy' : null), recentBudgetChars?: number) {
  const config = AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: { 'cc-pool': { agent_id: 'peggy', tmux_session: 'p', claude_bin: '/usr/local/bin/claude', working_dir: dir } },
    memory: {},
    ...(recentBudgetChars ? { agents: { 'agent:peggy': { memory: { recent_budget_chars: recentBudgetChars } } } } : {}),
  });
  const resolver = new RuntimeResolver(config);
  const recent = new RecentMemory({ config, resolver, now: () => now, log: () => {} });
  return new RecentFreshness({
    db, recent, resolveAgent, now: () => now,
    knownAgent: (id) => resolver.resolve(id.startsWith('agent:') ? id : `agent:${id}`) !== undefined,
  });
}

const daily = (date: string, text: string) => writeFileSync(join(dir, 'memory', 'daily', `${date}.md`), text);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'freshness-'));
  mkdirSync(join(dir, 'memory', 'daily'), { recursive: true });
  db = new Database(':memory:');
  runMigrations(db);
  now = new Date(2026, 9, 6, 10, 0);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('RecentFreshness, import mode (E67 S67.4)', () => {
  beforeEach(() => writeFileSync(join(dir, 'CLAUDE.md'), '# Peggy\n@memory/recent.md\n'));

  it('session-start records a baseline; a prompt gets content only after it changes, once', () => {
    const f = build();
    daily('2026-10-06', '- morning note');
    expect(f.check({ harnessSessionId: 'pane-1', event: 'session-start' })).toMatchObject({ ok: true, agent_id: 'agent:peggy', changed: false, reason: 'baseline', mode: 'import' });
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
    daily('2026-10-06', '- morning note\n- afternoon note'); // e.g. written in-turn; the check regenerates
    const changed = f.check({ harnessSessionId: 'pane-1', event: 'prompt' });
    expect(changed).toMatchObject({ ok: true, changed: true });
    const ctx = (changed as { context: string }).context;
    expect(ctx).toContain('new entries in memory/recent.md');
    expect(ctx).toContain('- afternoon note');
    expect(ctx).not.toContain('- morning note');
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it("a session's first prompt is its baseline when SessionStart isn't registered; sessions are tracked separately", () => {
    const f = build();
    daily('2026-10-06', 'a');
    expect(f.check({ harnessSessionId: 'pane-1' })).toMatchObject({ reason: 'baseline' });
    daily('2026-10-06', 'b');
    expect(f.check({ harnessSessionId: 'pane-1' })).toMatchObject({ changed: true });
    expect(f.check({ harnessSessionId: 'pane-2' })).toMatchObject({ reason: 'baseline' });
  });

  it('sends only the appended lines, per day; a new day comes whole', () => {
    const f = build();
    daily('2026-10-05', '- yesterday note');
    daily('2026-10-06', '- a');
    f.check({ harnessSessionId: 'pane-1', event: 'session-start' });
    daily('2026-10-06', '- a\n- b');
    const r1 = f.check({ harnessSessionId: 'pane-1' }) as { context: string };
    expect(r1.context).toContain('- b');
    expect(r1.context).not.toContain('- a\n');
    expect(r1.context).not.toContain('yesterday note');
    // Next check diffs against what was just sent.
    daily('2026-10-06', '- a\n- b\n- c');
    const r2 = f.check({ harnessSessionId: 'pane-1' }) as { context: string };
    expect(r2.context).toContain('- c');
    expect(r2.context).not.toContain('- b');
  });

  it('a rewritten day is sent whole; losing a day alone sends nothing', () => {
    const f = build();
    daily('2026-10-05', '- old day');
    daily('2026-10-06', '- a\n- b');
    f.check({ harnessSessionId: 'pane-1', event: 'session-start' });
    daily('2026-10-06', '- a\n- b edited');
    const r = f.check({ harnessSessionId: 'pane-1' }) as { context: string };
    expect(r.context).toContain('rewritten');
    expect(r.context).toContain('- b edited');
    now = new Date(2026, 9, 9, 8, 0); // lookback window slides past both days
    expect(f.check({ harnessSessionId: 'pane-1' })).toMatchObject({ changed: false, reason: 'no-new-entries' });
  });

  it('a session row from before migration 035 (no stored text) gets the whole file once', () => {
    const f = build();
    daily('2026-10-06', '- a');
    f.check({ harnessSessionId: 'pane-1', event: 'session-start' });
    db.prepare(`UPDATE memory_recent_seen SET content = NULL, content_hash = 'stale' WHERE harness_session_id = 'pane-1'`).run();
    const r = f.check({ harnessSessionId: 'pane-1' }) as { context: string };
    expect(r.context).toContain('changed since this session loaded it');
    expect(r.context).toContain('# Recent journal');
    expect(f.check({ harnessSessionId: 'pane-1' })).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it('import mode ignores the start source: a compact start is a baseline, not a resend', () => {
    const f = build();
    daily('2026-10-06', '- a');
    f.check({ harnessSessionId: 'pane-1', event: 'session-start', source: 'startup' });
    daily('2026-10-06', '- a\n- b');
    expect(f.check({ harnessSessionId: 'pane-1', event: 'session-start', source: 'compact' })).toMatchObject({ changed: false, reason: 'baseline', mode: 'import' });
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it('an agent with no working dir is treated as import mode (the import cannot be checked)', () => {
    const real = build();
    const f = new RecentFreshness({
      db,
      recent: {
        regenerate: (id, reason) => (real as unknown as { deps: { recent: RecentMemory } }).deps.recent.regenerate(id, reason),
        layoutFor: (id) => ({ ...(real as unknown as { deps: { recent: RecentMemory } }).deps.recent.layoutFor(id), workingDir: null }),
      },
      resolveAgent: () => 'agent:peggy',
      now: () => now,
    });
    daily('2026-10-06', '- a');
    expect(f.check({ harnessSessionId: 's', event: 'session-start', source: 'startup' })).toMatchObject({ ok: true, changed: false, reason: 'baseline', mode: 'import' });
  });

  it('recentDelta ignores the budget-cut note and left-out marker', () => {
    const prev = '# Recent journal\n\n## 2026-10-06 (today)\n\n- a\n- b\n\n_[1 older day(s) left out to fit the 500-character budget: `x`.]_\n';
    const next = '# Recent journal\n\n## 2026-10-06 (today)\n\n_[Earlier entries of this day were cut to fit the budget; the full journal is `x`.]_\n\n- a\n- b\n- c\n';
    expect(recentDelta(prev, next)).toBe('## 2026-10-06 (new entries only)\n\n- c');
  });

  describe('a day cut to fit the budget (cut point moves as newer days grow)', () => {
    const CUT = '_[Earlier entries of this day were cut to fit the budget; the full journal is `memory/daily/2026-10-05.md`.]_';
    const entry = (hhmm: string, kind: string, n: number) =>
      `## [${hhmm}] ${kind}\n- Checked item ${n} and found nothing that needs attention right now.\n- Follow-up for item ${n}: waiting on the owner to reply.`;
    const entries = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => entry(`09:${String(10 + from + i).padStart(2, '0')}`, 'scan', from + i)).join('\n\n');
    const file = (today: string, yesterday: string, cut: boolean) =>
      `<!-- Generated by AgentBus -->\n# Recent journal\n\n_The last 3 day(s) of daily journals._\n\n## 2026-10-06 (today)\n\n${today}\n\n## 2026-10-05\n\n${cut ? `${CUT}\n\n` : ''}${yesterday}\n`;

    it('sends only the new entry of today when the older day was cut later and nothing was added to it', () => {
      const prev = file(entries(20, 22), entries(1, 8), true);
      const next = file(`${entries(20, 22)}\n\n${entry('10:05', 'chat: Chris', 23)}`, entries(3, 8), true);
      const delta = recentDelta(prev, next);
      expect(delta).toBe(`## 2026-10-06 (new entries only)\n\n${entry('10:05', 'chat: Chris', 23)}`);
      expect(delta).not.toContain('rewritten');
      expect(delta).not.toContain('2026-10-05');
    });

    it('sends only the appended lines when the cut moved later and the day also grew', () => {
      const prev = file('- a', entries(3, 8), true);
      const next = file('- a', `${entries(5, 8)}\n\n${entry('11:00', 'scan', 9)}\n- Extra line after the entry.`, true);
      expect(recentDelta(prev, next)).toBe(`## 2026-10-05 (new entries only)\n\n${entry('11:00', 'scan', 9)}\n- Extra line after the entry.`);
    });

    it('also handles a day that was whole before and is cut now', () => {
      const prev = file('- a', entries(1, 6), false);
      const next = file('- a', `${entries(3, 6)}\n\n${entry('11:00', 'scan', 7)}`, true);
      expect(recentDelta(prev, next)).toBe(`## 2026-10-05 (new entries only)\n\n${entry('11:00', 'scan', 7)}`);
    });

    it('does not accept a short repeated line as an overlap', () => {
      const prev = file('- a', 'Opening note that is long enough to be a line of its own.\n- Nothing actionable.', true);
      const next = file('- a', '- Nothing actionable.\n- A brand new and unrelated entry that is not in the old text.', true);
      const delta = recentDelta(prev, next);
      expect(delta).toContain('2026-10-05 (rewritten; replaces the earlier version of this day)');
      expect(delta).toContain('- Nothing actionable.\n- A brand new');
    });

    it('does not accept an overlap that ends mid-line', () => {
      const line = 'A long enough line to clear the minimum overlap length easily.';
      const prev = file('- a', `first line of the old tail\n${line}`, true);
      const next = file('- a', `${line} and then it continued on the same line\nanother line`, true);
      expect(recentDelta(prev, next)).toContain('rewritten');
    });

    it('still resends a day that was edited in the middle', () => {
      const prev = file('- a', entries(1, 6), false);
      const next = file('- a', entries(1, 6).replace('Checked item 3', 'Rechecked item 3'), false);
      const delta = recentDelta(prev, next);
      expect(delta).toContain('## 2026-10-05 (rewritten; replaces the earlier version of this day)');
      expect(delta).toContain('Rechecked item 3');
      expect(delta).not.toContain('## 2026-10-06');
    });

    it('still resends a day whose last line was edited', () => {
      const prev = file('- a', entries(1, 4), false);
      const next = file('- a', `${entries(1, 4)} (edited)`, false);
      expect(recentDelta(prev, next)).toContain('rewritten');
    });

    it('keeps sub-headings inside a day: only date headings split days', () => {
      const prev = file('- a', entries(1, 4), true);
      const next = file(`- a\n\n${entry('10:30', 'chat: Chris', 2)}`, entries(2, 4), true);
      expect(recentDelta(prev, next)).toBe(`## 2026-10-06 (new entries only)\n\n${entry('10:30', 'chat: Chris', 2)}`);
    });

    it('picks the longest overlap when the old tail repeats a line', () => {
      const rep = 'A repeated entry long enough to count as a real overlap line.';
      const prev = file('- a', `${rep}\nmiddle line of the old tail\n${rep}`, true);
      const next = file('- a', `${rep}\nmiddle line of the old tail\n${rep}\nnew line one`, true);
      // The old text is a line-aligned prefix of the new one, so only the appended line is sent.
      expect(recentDelta(prev, next)).toBe('## 2026-10-05 (new entries only)\n\nnew line one');
      const cutLater = file('- a', `middle line of the old tail\n${rep}\nnew line one`, true);
      expect(recentDelta(prev, cutLater)).toBe('## 2026-10-05 (new entries only)\n\nnew line one');
    });

    describe('line diff: entries added anywhere in a day', () => {
      const added = (date: string, text: string) => `## ${date} (new entries only)\n\n${text}`;
      const live = entry('15:12', 'scan (bus)', 22);
      const inserted = entry('15:35', 'change log: routines table', 99);

      it('an entry inserted above the last entry sends only that entry', () => {
        const prev = file(`${entries(20, 21)}\n\n${live}`, entries(1, 4), false);
        const next = file(`${entries(20, 21)}\n\n${inserted}\n\n${live}`, entries(1, 4), false);
        const delta = recentDelta(prev, next);
        expect(delta).toBe(added('2026-10-06', inserted));
        expect(delta).not.toContain('rewritten');
      });

      it('two separate insertions in one day come as two blocks, nothing else', () => {
        const a = entry('09:45', 'chat: Chris', 50);
        const b = entry('16:00', 'chat: Chris', 51);
        const prev = file(entries(20, 22), entries(1, 4), false);
        const next = file(`${entries(20, 20)}\n\n${a}\n\n${entries(21, 22)}\n\n${b}`, entries(1, 4), false);
        expect(recentDelta(prev, next)).toBe(added('2026-10-06', `${a}\n\n${b}`));
      });

      it('an inserted entry that has a blank line inside it stays one block', () => {
        const multi = `${entry('15:35', 'notes', 60)}\n\n- A second paragraph of the same entry, after a blank line.`;
        const prev = file(`${entries(20, 21)}`, entries(1, 4), false);
        const next = file(`${entries(20, 20)}\n\n${multi}\n\n${entries(21, 21)}`, entries(1, 4), false);
        expect(recentDelta(prev, next)).toBe(added('2026-10-06', multi));
      });

      it('an insertion in a day whose budget cut also moved sends only the inserted lines', () => {
        const mid = entry('10:30', 'chat: Chris', 70);
        const prev = file('- a', entries(3, 8), true);
        const next = file('- a', `${entries(5, 6)}\n\n${mid}\n\n${entries(7, 8)}`, true);
        const delta = recentDelta(prev, next);
        expect(delta).toBe(added('2026-10-05', mid));
        expect(delta).not.toContain('rewritten');
      });

      it('whitespace-only changes send nothing', () => {
        const prev = file(entries(20, 22), entries(1, 4), false);
        const next = file(entries(20, 22).replace('\n\n## [09:31]', '\n\n\n## [09:31]').replace('owner to reply.', 'owner to reply.  ').replace(/$/, '\n\n   '), entries(1, 4), false);
        expect(next).not.toBe(prev);
        expect(recentDelta(prev, next)).toBe('');
      });

      it('an inserted line plus a real edit elsewhere resends the day', () => {
        const prev = file(entries(20, 22), entries(1, 4), false);
        const next = file(`${entries(20, 21)}\n\n${inserted}\n\n${entries(22, 22)}`.replace('Checked item 20', 'Rechecked item 20'), entries(1, 4), false);
        const delta = recentDelta(prev, next);
        expect(delta).toContain('## 2026-10-06 (rewritten; replaces the earlier version of this day)');
        expect(delta).toContain('Rechecked item 20');
        expect(delta).toContain('change log: routines table');
      });

      it('a removed entry resends the day', () => {
        const prev = file(entries(20, 22), entries(1, 4), false);
        const next = file(`${entries(20, 20)}\n\n${entries(22, 22)}`, entries(1, 4), false);
        expect(recentDelta(prev, next)).toContain('rewritten');
      });

      it('a day too large for the line diff falls back to the append, tail and overlap rules', () => {
        const prev = file(`${entries(20, 21)}\n\n${live}`, entries(3, 8), true);
        const insertedAbove = file(`${entries(20, 21)}\n\n${inserted}\n\n${live}`, entries(3, 8), true);
        const opts = { maxLcsCells: 1 };
        expect(recentDelta(prev, insertedAbove, opts)).toContain('## 2026-10-06 (rewritten; replaces the earlier version of this day)');
        expect(recentDelta(prev, insertedAbove)).toBe(added('2026-10-06', inserted));
        // Append, cut-moved-later and cut-moved-and-grew still work without the table.
        const appended = file(`${entries(20, 21)}\n\n${live}\n\n${inserted}`, entries(3, 8), true);
        expect(recentDelta(prev, appended, opts)).toBe(added('2026-10-06', inserted));
        const cutLater = file(`${entries(20, 21)}\n\n${live}`, entries(5, 8), true);
        expect(recentDelta(prev, cutLater, opts)).toBe('');
        const cutAndGrown = file(`${entries(20, 21)}\n\n${live}`, `${entries(5, 8)}\n\n${inserted}`, true);
        expect(recentDelta(prev, cutAndGrown, opts)).toBe(added('2026-10-05', inserted));
      });
    });
  });

  it('end to end: a day cut to the budget is not resent when the cut moves as today grows', () => {
    const f = build(undefined, 1500);
    const big = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `- ${tag} entry ${String(i).padStart(2, '0')}: something happened and was written down in a full sentence.`).join('\n');
    daily('2026-10-05', big('yesterday', 30));
    daily('2026-10-06', big('today', 10));
    expect(f.check({ harnessSessionId: 'pane-1', event: 'session-start' })).toMatchObject({ changed: false, reason: 'baseline' });
    const seen = (db.prepare('SELECT content FROM memory_recent_seen WHERE harness_session_id = ?').get('pane-1') as { content: string }).content;
    expect(seen).toContain('Earlier entries of this day were cut'); // truncation really happened
    daily('2026-10-06', `${big('today', 10)}\n- today entry 10: the one new entry, as a full sentence.`);
    const r = f.check({ harnessSessionId: 'pane-1', event: 'prompt' }) as { changed: boolean; context: string };
    expect(r.changed).toBe(true);
    expect(r.context).toContain('the one new entry');
    expect(r.context).not.toContain('rewritten');
    expect(r.context).not.toContain('yesterday entry');
    expect(r.context.length).toBeLessThan(600);
  });

  it('the midnight rollover alone sends nothing; the new day comes whole', () => {
    const f = build();
    daily('2026-10-06', 'a');
    f.check({ harnessSessionId: 'pane-1', event: 'session-start' });
    now = new Date(2026, 9, 7, 8, 0);
    expect(f.check({ harnessSessionId: 'pane-1' })).toMatchObject({ changed: false, reason: 'no-new-entries' });
    daily('2026-10-07', 'b');
    const r = f.check({ harnessSessionId: 'pane-1' }) as { context: string };
    expect(r.context).toContain('## 2026-10-07');
    expect(r.context).not.toContain('2026-10-06');
  });

  it('404 for an unknown session; agent= is a fallback only for configured agents', () => {
    const f = build(() => null);
    expect(f.check({ harnessSessionId: 'x' })).toMatchObject({ ok: false, status: 404 });
    expect(f.check({ harnessSessionId: 'x', agentId: 'nobody' })).toMatchObject({ ok: false, status: 404 });
    expect(f.check({ harnessSessionId: 'x', agentId: 'peggy' })).toMatchObject({ ok: true, agent_id: 'agent:peggy' });
  });

  it('no-recent when the agent has no memory dir', () => {
    rmSync(join(dir, 'memory'), { recursive: true, force: true });
    expect(build().check({ harnessSessionId: 'pane-1' })).toMatchObject({ ok: true, changed: false, reason: 'no-recent' });
  });

  it('sweeps rows untouched for 30 days', () => {
    const f = build();
    db.prepare(`INSERT INTO memory_recent_seen (harness_session_id, agent_id, content_hash, seen_at) VALUES ('old', 'agent:peggy', 'h', ?)`).run(new Date(2026, 7, 1).toISOString());
    f.check({ harnessSessionId: 'pane-1' }); // sweeps on the first check
    expect(db.prepare(`SELECT harness_session_id FROM memory_recent_seen`).all()).toEqual([{ harness_session_id: 'pane-1' }]);
  });

  it('parses the query', () => {
    expect(parseFreshnessQuery({})).toEqual({ error: 'harness_session_id is required' });
    expect(parseFreshnessQuery({ harness_session_id: 's', event: 'nope' })).toEqual({ error: 'event must be prompt or session-start' });
    expect(parseFreshnessQuery({ harness_session_id: 's', event: 'prompt', agent: 'baxter' })).toEqual({ harnessSessionId: 's', event: 'prompt', agentId: 'baxter' });
    for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
      expect(parseFreshnessQuery({ harness_session_id: 's', event: 'session-start', source })).toEqual({ harnessSessionId: 's', event: 'session-start', source });
    }
    expect(parseFreshnessQuery({ harness_session_id: 's', source: 'bogus' })).toEqual({ error: 'source must be one of startup, resume, clear, compact, fork' });
    expect(parseFreshnessQuery({ harness_session_id: 's', source: '' })).toMatchObject({ error: expect.stringContaining('source must be') });
  });
});

describe('RecentFreshness, hook mode (E73 S73.2)', () => {
  const start = (f: RecentFreshness, id: string, source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork') =>
    f.check({ harnessSessionId: id, event: 'session-start', source });
  const ctx = (r: unknown) => (r as { context: string }).context;

  it('a new session gets the whole file on startup, then nothing while unchanged', () => {
    const f = build(); // no CLAUDE.md import
    daily('2026-10-05', '- yesterday note');
    daily('2026-10-06', '- a');
    const r = start(f, 'pane-1', 'startup');
    expect(r).toMatchObject({ ok: true, agent_id: 'agent:peggy', changed: true, mode: 'hook' });
    expect(r).not.toHaveProperty('reason');
    expect(ctx(r)).toContain('memory/recent.md, your recent daily journals (loaded by the freshness hook; later updates arrive as new entries only):');
    expect(ctx(r)).toContain('# Recent journal');
    expect(ctx(r)).toContain('- yesterday note');
    expect(ctx(r)).toContain('- a');
    expect(start(f, 'pane-1', 'resume')).toMatchObject({ changed: false, reason: 'unchanged', mode: 'hook' });
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it('resume and prompt send only the lines appended since', () => {
    const f = build();
    daily('2026-10-06', '- a');
    start(f, 'pane-1', 'startup');
    daily('2026-10-06', '- a\n- b');
    const r = start(f, 'pane-1', 'resume');
    expect(r).toMatchObject({ changed: true, mode: 'hook' });
    expect(ctx(r)).toContain('new entries in memory/recent.md');
    expect(ctx(r)).toContain('- b');
    expect(ctx(r)).not.toContain('# Recent journal');
    daily('2026-10-06', '- a\n- b\n- c');
    const r2 = f.check({ harnessSessionId: 'pane-1', event: 'prompt' });
    expect(ctx(r2)).toContain('- c');
    expect(ctx(r2)).not.toContain('- b');
  });

  it('compact sends the whole file again, even when nothing changed; the resume before it does not', () => {
    const f = build();
    daily('2026-10-06', '- a');
    start(f, 'pane-1', 'startup');
    expect(start(f, 'pane-1', 'resume')).toMatchObject({ changed: false, reason: 'unchanged' }); // fires right before compact, same call
    const r = start(f, 'pane-1', 'compact');
    expect(r).toMatchObject({ changed: true, mode: 'hook' });
    expect(ctx(r)).toContain('(loaded by the freshness hook');
    expect(ctx(r)).toContain('# Recent journal');
    expect(ctx(r)).toContain('- a');
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it('clear and fork arrive with a new session id, so they get the whole file', () => {
    const f = build();
    daily('2026-10-06', '- a');
    start(f, 'pane-1', 'startup');
    for (const [id, source] of [['pane-2', 'clear'], ['pane-3', 'fork']] as const) {
      const r = start(f, id, source);
      expect(r).toMatchObject({ changed: true, mode: 'hook' });
      expect(ctx(r)).toContain('# Recent journal');
    }
  });

  it('a prompt for a session with no row (no SessionStart hook, or the bus was down) gets the whole file', () => {
    const f = build();
    daily('2026-10-06', '- a');
    const r = f.check({ harnessSessionId: 'pane-1', event: 'prompt' });
    expect(r).toMatchObject({ changed: true, mode: 'hook' });
    expect(ctx(r)).toContain('# Recent journal');
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
    // The same for a check without an event.
    expect(f.check({ harnessSessionId: 'pane-2' })).toMatchObject({ changed: true });
  });

  it('a legacy row without stored text gets the whole file once', () => {
    const f = build();
    daily('2026-10-06', '- a');
    start(f, 'pane-1', 'startup');
    db.prepare(`UPDATE memory_recent_seen SET content = NULL, content_hash = 'stale' WHERE harness_session_id = 'pane-1'`).run();
    const r = start(f, 'pane-1', 'resume');
    expect(r).toMatchObject({ changed: true });
    expect(ctx(r)).toContain('changed since this session loaded it');
    expect(ctx(r)).toContain('# Recent journal');
    expect(start(f, 'pane-1', 'resume')).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it('the midnight rollover alone sends nothing; the new day comes whole', () => {
    const f = build();
    daily('2026-10-06', '- a');
    start(f, 'pane-1', 'startup');
    now = new Date(2026, 9, 7, 8, 0);
    expect(start(f, 'pane-1', 'resume')).toMatchObject({ changed: false, reason: 'no-new-entries', mode: 'hook' });
    daily('2026-10-07', '- b');
    const r = f.check({ harnessSessionId: 'pane-1', event: 'prompt' });
    expect(ctx(r)).toContain('## 2026-10-07');
    expect(ctx(r)).not.toContain('2026-10-06');
  });

  it('an import added later switches the agent to import mode', () => {
    const f = build();
    daily('2026-10-06', '- a');
    expect(start(f, 'pane-1', 'startup')).toMatchObject({ changed: true, mode: 'hook' });
    writeFileSync(join(dir, 'CLAUDE.md'), '@memory/recent.md\n');
    expect(start(f, 'pane-2', 'startup')).toMatchObject({ changed: false, reason: 'baseline', mode: 'import' });
  });
});

// ── The hook script against a stub bus ──────────────────────────────────────

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/hooks/agentbus_recent_memory_hook.sh');
const hasJq = ['/usr/bin/jq', '/opt/homebrew/bin/jq', '/usr/local/bin/jq'].some((p) => existsSync(p));

describe.skipIf(!hasJq)('agentbus_recent_memory_hook.sh', { timeout: 30_000 }, () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  async function stubBus(response: unknown): Promise<{ url: string; seen: Array<{ url: string; token: string | undefined }> }> {
    const seen: Array<{ url: string; token: string | undefined }> = [];
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', token: req.headers['x-bus-token'] as string | undefined });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  function runHook(input: unknown, env: Record<string, string>): Promise<string> {
    return new Promise((done) => {
      let out = '';
      const child = spawn('/bin/bash', [HOOK], { env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('close', () => done(out));
      child.stdin.end(JSON.stringify(input));
    });
  }

  const FULL = { ok: true, changed: true, context: 'AgentBus: memory/recent.md, your recent daily journals (loaded by the freshness hook; later updates arrive as new entries only):\n\n# Recent journal' };

  it('UserPromptSubmit prints the context when it changed, sending the token on stdin', async () => {
    const { url, seen } = await stubBus({ ok: true, changed: true, context: 'AgentBus: memory/recent.md changed\n\nnew stuff' });
    const out = await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess 1', prompt: 'hi' }, { AGENTBUS_URL: url, AGENTBUS_BUS_TOKEN: 'tok' });
    expect(out).toContain('new stuff');
    expect(seen[0]!.url).toBe('/api/v1/memory/recent?harness_session_id=sess%201&event=prompt');
    expect(seen[0]!.token).toBe('tok');
  });

  it('SessionStart passes the source and prints the context when the bus says changed', async () => {
    const { url, seen } = await stubBus(FULL);
    const out = await runHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }, { AGENTBUS_URL: url, AGENTBUS_AGENT_ID: 'peggy' });
    expect(out).toContain('# Recent journal');
    expect(seen[0]!.url).toBe('/api/v1/memory/recent?harness_session_id=s&event=session-start&source=startup&agent=peggy');
  });

  it('prints nothing when unchanged, and nothing when the bus is down on UserPromptSubmit', async () => {
    const { url } = await stubBus({ ok: true, changed: false, reason: 'unchanged' });
    expect(await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's' }, { AGENTBUS_URL: url })).toBe('');
    expect(await runHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'resume' }, { AGENTBUS_URL: url })).toBe('');
    expect(await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's' }, { AGENTBUS_URL: 'http://127.0.0.1:9', AGENTBUS_RECENT_FILE: recentFile() })).toBe('');
  });

  function recentFile(): string {
    const f = join(mkdtempSync(join(tmpdir(), 'hook-recent-')), 'recent.md');
    writeFileSync(f, '# Recent journal\n\n- from disk\n');
    return f;
  }

  it('SessionStart falls back to the file on disk when the bus is down, for startup, clear, compact and fork', async () => {
    const file = recentFile();
    for (const source of ['startup', 'clear', 'compact', 'fork']) {
      const out = await runHook({ hook_event_name: 'SessionStart', session_id: 's', source }, { AGENTBUS_URL: 'http://127.0.0.1:9', AGENTBUS_RECENT_FILE: file });
      expect(out).toContain('the bus was unreachable');
      expect(out).toContain(file);
      expect(out).toContain('- from disk');
    }
  });

  it('no disk fallback on resume, without AGENTBUS_RECENT_FILE, or for an unreadable file', async () => {
    const file = recentFile();
    const down = { AGENTBUS_URL: 'http://127.0.0.1:9' };
    expect(await runHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'resume' }, { ...down, AGENTBUS_RECENT_FILE: file })).toBe('');
    expect(await runHook({ hook_event_name: 'SessionStart', session_id: 's' }, { ...down, AGENTBUS_RECENT_FILE: file })).toBe('');
    expect(await runHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }, down)).toBe('');
    expect(await runHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }, { ...down, AGENTBUS_RECENT_FILE: join(dirname(file), 'missing.md') })).toBe('');
  });

  it('falls back on a bus error (non-2xx) or an unparsable answer, but not when the bus says nothing changed', async () => {
    const file = recentFile();
    const input = { hook_event_name: 'SessionStart', session_id: 's', source: 'startup' };
    server = createServer((_req, res) => { res.statusCode = 404; res.end('{"ok":false}'); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await runHook(input, { AGENTBUS_URL: url, AGENTBUS_RECENT_FILE: file })).toContain('- from disk');
    await new Promise<void>((r) => server!.close(() => r()));
    server = createServer((_req, res) => { res.end('not json'); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url2 = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await runHook(input, { AGENTBUS_URL: url2, AGENTBUS_RECENT_FILE: file })).toContain('- from disk');
    await new Promise<void>((r) => server!.close(() => r()));
    const { url: url3 } = await stubBus({ ok: true, changed: false, reason: 'baseline' });
    expect(await runHook(input, { AGENTBUS_URL: url3, AGENTBUS_RECENT_FILE: file })).toBe('');
  });

  it('exits 0 without a session id', () => {
    const r = spawnSync('/bin/bash', [HOOK], { input: '{}', env: { PATH: process.env['PATH'] } });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('');
  });
});
