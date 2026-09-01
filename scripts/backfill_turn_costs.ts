/**
 * One-time backfill: seed `turn_costs` with historical cost data already
 * sitting in `~/.claude/projects/<encoded-working-dir>/*.jsonl` transcripts,
 * so /cost's day-1 numbers aren't all zero (E39, S39.5).
 *
 * Manual operator step — run once with `npx tsx scripts/backfill_turn_costs.ts`.
 * Not wired into any startup path.
 *
 * Deviation from the epic's original research note: that note assumed these
 * transcripts contain per-turn `type: "result"` stream-json events carrying
 * `total_cost_usd`/`usage`/`num_turns` (the shape `claude -p
 * --output-format stream-json` actually emits on stdout, which is what
 * cc-headless.ts's live capture (S39.2/S39.3) correctly parses). Checked
 * against real transcripts on this machine (both this repo's and Peggy's
 * working_dir) before writing this script: resumable session transcripts
 * under ~/.claude/projects don't contain `result` events at all. Instead
 * they periodically checkpoint a `type: "cost-state"` line with a *cumulative*
 * `totalCostUSD` for the whole resumable session (plus a per-model
 * `modelUsage` breakdown), and no timestamp of its own.
 *
 * This script handles both shapes defensively:
 *   - Per-turn `result` events, if a transcript ever contains them: one row
 *     per event, using the event's own `timestamp` field.
 *   - `cost-state` checkpoints (the shape actually observed): one row per
 *     file, using the *last* checkpoint's cumulative total and the file's
 *     mtime as the timestamp — a coarse approximation (the whole resumable
 *     session's cost bucketed to one point in time), acceptable for a
 *     one-time "so the numbers aren't zero" backfill but not a substitute
 *     for the per-turn ledger S39.2/S39.3 now write going forward.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/schema.js';
import { loadConfig } from '../src/config/loader.js';
import { getCcHeadlessInstances } from '../src/config/schema.js';

interface CostRow {
  sessionId: string;
  ts: string;
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

/** Claude Code's project-dir encoding: every `/` in the absolute working dir becomes `-`. */
export function encodeProjectDir(workingDir: string): string {
  return resolve(workingDir).replace(/\//g, '-');
}

interface ResultEvent {
  type: 'result';
  session_id?: string;
  timestamp?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  num_turns?: number;
}

interface CostStateEvent {
  type: 'cost-state';
  sessionId?: string;
  totalCostUSD?: number;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>;
}

/**
 * Pure. Extracts backfill-able cost rows from one transcript file's raw
 * lines. `fallbackSessionId`/`fallbackTsIso` (the file's basename-derived
 * session id and mtime) are used for the `cost-state` fallback path, which
 * has no timestamp or explicit session id of its own on the line.
 */
export function extractCostRows(lines: string[], fallbackSessionId: string, fallbackTsIso: string): CostRow[] {
  const resultRows: CostRow[] = [];
  let lastCostState: CostStateEvent | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null || !('type' in obj)) continue;

    if ((obj as { type: unknown }).type === 'result') {
      const event = obj as ResultEvent;
      if (typeof event.total_cost_usd === 'number') {
        resultRows.push({
          sessionId: event.session_id ?? fallbackSessionId,
          ts: event.timestamp ?? fallbackTsIso,
          costUsd: event.total_cost_usd,
          inputTokens: event.usage?.input_tokens ?? null,
          outputTokens: event.usage?.output_tokens ?? null,
          numTurns: event.num_turns ?? null,
        });
      }
    } else if ((obj as { type: unknown }).type === 'cost-state') {
      lastCostState = obj as CostStateEvent;
    }
  }

  // Prefer real per-turn result events when present; only fall back to the
  // coarse whole-session cost-state snapshot when none were found.
  if (resultRows.length > 0) return resultRows;

  if (lastCostState && typeof lastCostState.totalCostUSD === 'number') {
    let inputTokens = 0;
    let outputTokens = 0;
    let sawTokens = false;
    for (const usage of Object.values(lastCostState.modelUsage ?? {})) {
      if (typeof usage.inputTokens === 'number') { inputTokens += usage.inputTokens; sawTokens = true; }
      if (typeof usage.outputTokens === 'number') { outputTokens += usage.outputTokens; sawTokens = true; }
    }
    return [{
      sessionId: lastCostState.sessionId ?? fallbackSessionId,
      ts: fallbackTsIso,
      costUsd: lastCostState.totalCostUSD,
      inputTokens: sawTokens ? inputTokens : null,
      outputTokens: sawTokens ? outputTokens : null,
      numTurns: null,
    }];
  }

  return [];
}

function main(): void {
  const configPath = process.env['AGENTBUS_CONFIG'] ?? resolve(process.cwd(), 'config.yaml');
  const config = loadConfig(configPath);
  const db = getDb(config.bus.db_path);
  runMigrations(db);

  const alreadyBackfilled = db.prepare(`SELECT 1 FROM turn_costs WHERE session_id = ? LIMIT 1`);
  const insert = db.prepare(
    `INSERT INTO turn_costs (agent_id, session_id, ts, cost_usd, input_tokens, output_tokens, num_turns)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let filesScanned = 0;
  let rowsInserted = 0;
  let rowsSkipped = 0;

  for (const instCfg of getCcHeadlessInstances(config)) {
    const agentId = `agent:${instCfg.agent_id}`;
    const workingDir = instCfg.working_dir ?? process.cwd();
    const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(workingDir));

    let files: string[];
    try {
      files = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      console.warn(`[backfill] No transcript directory for ${agentId} (${projectDir}) — skipping`);
      continue;
    }

    for (const file of files) {
      filesScanned++;
      const path = join(projectDir, file);
      const fallbackSessionId = file.replace(/\.jsonl$/, '');
      const mtimeIso = statSync(path).mtime.toISOString();
      const lines = readFileSync(path, 'utf-8').split('\n');

      for (const row of extractCostRows(lines, fallbackSessionId, mtimeIso)) {
        if (alreadyBackfilled.get(row.sessionId)) {
          rowsSkipped++;
          continue;
        }
        insert.run(agentId, row.sessionId, row.ts, row.costUsd, row.inputTokens, row.outputTokens, row.numTurns);
        rowsInserted++;
      }
    }
  }

  console.log(`[backfill] Scanned ${filesScanned} transcript file(s): inserted ${rowsInserted} row(s), skipped ${rowsSkipped} already-backfilled session(s).`);
}

main();
