/**
 * /journal (E66 S66.10): journaling status, recent runs, and a manual run.
 *
 *   /journal            status for this conversation and its agent
 *   /journal runs [n]   the agent's last n journal attempts (default 5, max 20)
 *   /journal now        journal this conversation now (trigger `manual`):
 *                       bypasses the pause threshold and min_human_messages,
 *                       respects the cursor
 */
import type Database from 'better-sqlite3';
import type { CommandDefinition, SlashCommandContext } from './registry.js';
import { commandConversationId } from './handlers.js';
import { agentStatus, conversationStatus, type JournalStatusDeps } from '../journaling/status.js';
import type { EvaluationResult } from '../journaling/engine.js';
import type { JournalRunRow } from '../journaling/store.js';

export interface JournalCommandDeps extends JournalStatusDeps {
  /** How long `/journal now` waits for a quick answer before replying "started". Default 1500 ms. */
  nowWaitMs?: number;
}

/** "3m ago", "2h ago", "4d ago". */
export function ago(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const usd = (v: number | null) => (v === null ? '' : ` $${v.toFixed(v < 0.01 ? 4 : 2)}`);

function contactOf(ctx: SlashCommandContext): string {
  return ctx.sender.startsWith('contact:') ? ctx.sender.slice('contact:'.length) : ctx.sender;
}

/** The agent this conversation journals with: its session's, else the only journaling agent. */
function agentFor(deps: JournalCommandDeps, conversationId: string): string | null {
  const session = deps.engine.sessionForConversation(conversationId);
  const fromSession = session ? deps.engine.agentForSession(session)?.agentId : undefined;
  if (fromSession) return fromSession;
  const all = deps.engine.allSettings();
  return all.length === 1 ? all[0]!.agentId : null;
}

function statusBody(deps: JournalCommandDeps, conversationId: string): string {
  const now = deps.now?.() ?? new Date();
  const conv = conversationStatus(deps, conversationId);
  const agentId = conv?.agentId ?? agentFor(deps, conversationId);
  const agent = agentId ? agentStatus(deps, agentId) : null;
  if (!agent) return 'Journaling is not set up for this conversation\'s agent.';

  const lines = ['Journaling', '', 'This conversation:'];
  if (!conv) {
    lines.push('  no session yet');
  } else {
    lines.push(`  last journaled: ${ago(conv.lastJournaledAt, now)}`);
    const pending = conv.unjournaledHuman > 0 && conv.minHumanMessages !== null && conv.unjournaledHuman < conv.minHumanMessages
      ? ` (journaled at ${conv.minHumanMessages}, or when the session ends)` : '';
    lines.push(`  waiting: ${conv.unjournaledHuman} message(s) from people${pending}`);
    if (conv.pendingTrigger) lines.push(`  pending: ${conv.pendingTrigger}`);
    if (conv.heldBy) lines.push(`  in progress: run ${conv.heldBy.slice(0, 8)} (messages wait until it finishes)`);
    else if (conv.inFlight) lines.push('  in progress: yes');
  }
  lines.push('', `Agent ${agent.agentId}${agent.runtime ? ` (${agent.runtime})` : ''}:`);
  if (!agent.enabled) lines.push('  disabled');
  const skipped = agent.chain.filter((id) => !agent.runnable.includes(id));
  lines.push(`  chain: ${agent.chain.join(' → ')}${skipped.length > 0 ? ` (${skipped.join(', ')} can't run on ${agent.runtime ?? 'this runtime'})` : ''}`);
  lines.push(`  last success: ${ago(agent.lastSuccessAt, now)}`);
  if (agent.consecutiveExhaustions > 0) lines.push(`  failed runs in a row: ${agent.consecutiveExhaustions}`);
  if (agent.lastFailure) lines.push(`  last failure (${ago(agent.lastFailureAt, now)}): ${agent.lastFailure}`);
  if (agent.backlogSince) lines.push(`  backlog: ${agent.backlogSessions} conversation(s), oldest ${ago(agent.backlogSince, now)}`);
  if (agent.hooks.length > 0) lines.push(`  hooks: ${agent.hooks.map((h) => `${h.event} ${h.status}`).join(', ')}`);
  for (const a of agent.advisories) lines.push(`  [${a.severity}] ${a.title} (${a.state})`);
  return lines.join('\n');
}

function runLine(r: JournalRunRow, now: Date): string {
  const from = r.fallback_from ? ` after ${r.fallback_from}` : '';
  const fidelity = r.fidelity ? `, saw ${r.fidelity}` : '';
  const err = r.error && r.outcome !== 'done' && r.outcome !== 'nothing-to-do' ? `: ${r.error.slice(0, 120)}` : '';
  const notes = r.notes && r.outcome === 'done' ? ` — ${r.notes.slice(0, 80)}` : '';
  return `${ago(r.started_at, now)} ${r.trigger} ${r.journaler}${from}: ${r.outcome}${fidelity}${usd(r.cost_usd)}${err}${notes}`;
}

function runsBody(deps: JournalCommandDeps, conversationId: string, n: number): string {
  const agentId = agentFor(deps, conversationId);
  if (!agentId) return 'Journaling is not set up for this conversation\'s agent.';
  const runs = deps.engine.store.listRuns({ agentId: deps.engine.settingsFor(agentId)?.agentId ?? agentId, limit: n });
  if (runs.length === 0) return 'No journal runs yet.';
  const now = deps.now?.() ?? new Date();
  return [`Last ${runs.length} journal attempt(s):`, ...runs.map((r) => `  ${runLine(r, now)}`)].join('\n');
}

function describeResult(r: EvaluationResult): string {
  switch (r.status) {
    case 'journaled': return `Journaled with ${r.summary?.journaler ?? 'a journaler'}.`;
    case 'nothing-to-do': return 'Journal run finished: nothing worth recording.';
    case 'nothing': return 'Nothing new to journal since the last run.';
    case 'exhausted': return 'Journal run failed: no journaler could finish. /journal runs shows why.';
    case 'not-configured': return 'Journaling is not set up for this conversation\'s agent.';
    case 'disabled': return 'Journaling is disabled for this agent.';
    case 'unknown-session': return 'No session yet for this conversation.';
    default: return `Journal run ended: ${r.status}${r.error ? ` (${r.error})` : ''}.`;
  }
}

async function nowBody(deps: JournalCommandDeps, conversationId: string): Promise<string> {
  const handle = deps.engine.trigger({ reason: 'manual', conversationId });
  if (handle.status === 'unknown-session') return 'No session yet for this conversation.';
  if (handle.status === 'not-configured') return 'Journaling is not set up for this conversation\'s agent.';
  if (handle.status === 'disabled') return 'Journaling is disabled for this agent.';
  const waitMs = deps.nowWaitMs ?? 1500;
  const quick = await Promise.race([
    handle.done,
    new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), waitMs); t.unref?.(); }),
  ]);
  if (quick) return describeResult(quick);
  return 'Journaling this conversation now. /journal runs shows the result.';
}

export function createJournalCommand(deps: JournalCommandDeps & { db: Database.Database }): CommandDefinition {
  return {
    name: 'journal',
    description: 'Journaling status, recent runs, or journal this conversation now',
    usage: '/journal [runs [n] | now]',
    scope: 'bus',
    handler: async (args, ctx) => {
      const conversationId = commandConversationId(ctx, deps.db, contactOf(ctx));
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === '' || sub === 'status') return { body: statusBody(deps, conversationId) };
      if (sub === 'runs') {
        const n = Math.max(1, Math.min(Number.parseInt(args[1] ?? '5', 10) || 5, 20));
        return { body: runsBody(deps, conversationId, n) };
      }
      if (sub === 'now') return { body: await nowBody(deps, conversationId) };
      return { body: 'Usage:\n  /journal           journaling status\n  /journal runs [n]  recent journal runs\n  /journal now       journal this conversation now' };
    },
  };
}
