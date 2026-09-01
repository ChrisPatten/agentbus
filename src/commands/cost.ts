/**
 * `/cost` — day/week/month API spend for the calling agent (E39).
 *
 * Factored into its own module (rather than living inline in handlers.ts)
 * so the agent-resolution and date-range arithmetic can be exercised in a
 * unit test without pulling in index.ts's startup side effects — the same
 * extraction pattern as `src/commands/torrent.ts`.
 */
import type Database from 'better-sqlite3';
import type { CommandDefinition, SlashCommandContext } from './registry.js';
import type { HeadlessControl } from './handlers.js';

export interface CostCommandDeps {
  db: Database.Database;
  headlessControl?: HeadlessControl;
  /** Injectable for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

interface SessionAgentRow {
  agent_id: string | null;
}

/**
 * Resolve the agent to report cost for, the same way `/stop` resolves the
 * agent to kill a turn on: look up the sender's active session on this
 * channel and take its `agent_id`; if there is no session or it predates
 * `agent_id` tracking (migration 011), fall back to the sole registered
 * cc-headless instance when there's only one running. Unlike `/stop`, an
 * `agent_id` that no longer matches a running instance (E23 retirement) is
 * still usable here — the query just returns its historical cost, if any.
 */
export function resolveAgentId(deps: CostCommandDeps, ctx: SlashCommandContext): string | null {
  const contactId = ctx.sender.startsWith('contact:') ? ctx.sender.slice('contact:'.length) : ctx.sender;

  const session = deps.db
    .prepare(
      `SELECT agent_id FROM sessions
       WHERE contact_id = ? AND channel = ? AND ended_at IS NULL
       ORDER BY last_activity DESC LIMIT 1`,
    )
    .get(contactId, ctx.channel) as SessionAgentRow | undefined;

  if (session?.agent_id) return session.agent_id;

  const runners = deps.headlessControl?.stopTurn;
  if (runners?.size === 1) return [...runners.keys()][0]!;

  return null;
}

/** Local midnight (start of "today") for `now`. */
export function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Rolling 7-day window start ("this week"). */
export function startOfWeek(now: Date): Date {
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

/** The 1st of the current calendar month, local time ("this month"). */
export function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function sumCostSince(db: Database.Database, agentId: string, since: Date): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM turn_costs WHERE agent_id = ? AND ts >= ?`)
    .get(agentId, since.toISOString()) as { total: number };
  return row.total;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function createCostCommand(deps: CostCommandDeps): CommandDefinition {
  return {
    name: 'cost',
    description: 'Show day/week/month API cost for this agent',
    usage: '/cost',
    scope: 'bus',
    handler: async (_args, ctx) => {
      const agentId = resolveAgentId(deps, ctx);
      if (!agentId) {
        return { body: 'Could not determine which agent to report cost for.' };
      }

      const now = (deps.now ?? (() => new Date()))();
      const today = sumCostSince(deps.db, agentId, startOfToday(now));
      const week = sumCostSince(deps.db, agentId, startOfWeek(now));
      const month = sumCostSince(deps.db, agentId, startOfMonth(now));

      return {
        body: [`Today: ${formatUsd(today)}`, `This week: ${formatUsd(week)}`, `This month: ${formatUsd(month)}`].join('\n'),
      };
    },
  };
}
