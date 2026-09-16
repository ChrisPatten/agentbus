/**
 * Gate 0 for the Siri bridge (E42 / S42.1): historical time-to-first-reply for
 * Peggy's turns, computed from the transcripts table.
 *
 * Per inbound message on a channel matching `--channel` (default `telegram%`),
 * finds the first outbound transcript row in the same conversation after it and
 * reports n / mean / p50 / p95 / max in seconds. Replies more than 600 s later
 * are ignored (not a "turn"). Percentiles are computed here from the per-row
 * dump, so no spreadsheet step is needed.
 *
 * Always runs against a fresh backup copy of the live DB (better-sqlite3's
 * online backup API), never the live file, so it cannot interfere with bus-core.
 *
 * Usage:
 *   npx tsx scripts/siri-gate0-latency.ts [--db ~/.agentbus_data/agentbus.db] [--days 14] [--channel 'telegram%'] [--dump]
 *
 * See _bmad-output/planning-artifacts/siri-bridge/implementation-plan.md §2.
 */
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const dbPath = arg('db', join(homedir(), '.agentbus_data', 'agentbus.db'));
const days = Number(arg('days', '14'));
const channel = arg('channel', 'telegram%');
const dump = process.argv.includes('--dump');

const backupPath = join(mkdtempSync(join(tmpdir(), 'siri-gate0-')), 'agentbus-copy.db');
const live = new Database(dbPath, { readonly: true });
await live.backup(backupPath);
live.close();

const db = new Database(backupPath, { readonly: true });
const rows = db
  .prepare(
    `WITH inbound AS (
       SELECT id, conversation_id, created_at, substr(body, 1, 40) AS preview FROM transcripts
       WHERE direction = 'inbound' AND channel LIKE ? AND created_at >= datetime('now', ?)
     ),
     paired AS (
       SELECT i.id, i.created_at AS asked_at, i.preview,
              (SELECT MIN(o.created_at) FROM transcripts o
                 WHERE o.conversation_id = i.conversation_id AND o.direction = 'outbound' AND o.created_at > i.created_at) AS answered_at
       FROM inbound i
     )
     SELECT id, asked_at, answered_at, preview,
            (julianday(answered_at) - julianday(asked_at)) * 86400 AS seconds
     FROM paired
     WHERE answered_at IS NOT NULL AND (julianday(answered_at) - julianday(asked_at)) * 86400 < 600
     ORDER BY asked_at`,
  )
  .all(channel, `-${days} days`) as Array<{ id: string; asked_at: string; answered_at: string; preview: string; seconds: number }>;
db.close();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

const secs = rows.map((r) => r.seconds).sort((a, b) => a - b);
const mean = secs.reduce((a, b) => a + b, 0) / (secs.length || 1);

if (dump) {
  for (const r of rows) console.log(`${r.asked_at}\t${r.seconds.toFixed(1)}s\t${r.preview.replace(/\s+/g, ' ')}`);
  console.log('');
}

console.log(`Gate 0 — time to first outbound reply, channel LIKE '${channel}', last ${days} days (replies > 600 s excluded)`);
console.log(`n=${secs.length} mean=${mean.toFixed(1)}s p50=${percentile(secs, 50).toFixed(1)}s p95=${percentile(secs, 95).toFixed(1)}s max=${(secs.at(-1) ?? NaN).toFixed(1)}s`);
console.log(`(backup copy used: ${backupPath})`);
