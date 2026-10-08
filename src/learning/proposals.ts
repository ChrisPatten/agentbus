/**
 * Self-edit proposals (E68 S68.3). See docs/AGENT_LEARNING.md#self-edit-proposals.
 *
 * An agent can't edit its protected files (S68.4), but it can propose a
 * change: `propose_change({ path, new_content | diff, rationale, evidence })`
 * over MCP (POST /api/v1/proposals), or `proposals[]` in a script
 * journaler's stdout. The bus:
 *
 *   1. checks the path is protected, computes the new content (applying a
 *      unified diff to the current file), the file's base hash and a
 *      compact diff, and enforces at most 3 proposals per agent per 24 h;
 *   2. stores the proposal and sends each owner an approval request
 *      (approval_requests, adapter_id `self-edit`, 7-day expiry) with the
 *      rationale, evidence and diff, answered Approve/Deny only;
 *   3. on the first answer: approve → write the file if its hash still
 *      equals the base (else `stale`; the agent may propose again), and
 *      tell the protected-path monitor the new hash; deny → `denied` (the
 *      approval path records a denied-approval feedback event). The other
 *      owners' requests are marked stale.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import type Database from 'better-sqlite3';
import type { ApprovalStore } from '../approvals/store.js';
import type { ApprovalDecision, ApprovalRequest } from '../approvals/types.js';
import type { OwnerDirectory } from '../core/owners.js';
import { applyUnifiedDiff, compactDiff, DiffApplyError } from './diff.js';
import { displayPath, hashFile, isProtectedPath, type ProtectedPaths } from './protected-paths.js';

/** approval_requests.adapter_id of proposal requests. */
export const SELF_EDIT_ADAPTER = 'self-edit';
export const PROPOSAL_TOOL_NAME = 'propose_change';
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PROPOSALS_PER_DAY = 3;
export const MAX_PROPOSAL_BYTES = 256 * 1024;
const MAX_RATIONALE = 2000;
const MAX_EVIDENCE_ITEMS = 10;
const MAX_EVIDENCE_ITEM = 300;
/** Characters of diff in an approval message (Telegram allows 4096 in all). */
const DIFF_IN_APPROVAL = 1800;

export type ProposalStatus = 'pending' | 'applied' | 'denied' | 'stale' | 'expired' | 'failed';

export interface ProposalRow {
  id: string;
  agent_id: string;
  path: string;
  abs_path: string;
  base_hash: string;
  new_content: string;
  new_hash: string;
  diff: string;
  rationale: string;
  evidence: string | null;
  source: string;
  run_id: string | null;
  status: ProposalStatus;
  status_reason: string | null;
  approval_ids: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface ProposalInput {
  /** Any id form: bare, prefixed or a pool pane id. */
  agentId: string;
  path: string;
  newContent?: string;
  diff?: string;
  rationale: string;
  evidence?: string[] | string;
  source: 'mcp' | 'script' | 'api';
  runId?: string | null;
}

export type ProposalError =
  | 'unknown_agent' | 'no_protected_paths' | 'not_protected' | 'invalid' | 'diff_failed' | 'no_change'
  | 'too_large' | 'rate_limited' | 'no_owners' | 'not_delivered';

export type SubmitResult =
  | { ok: true; proposal: ProposalRow; notified: number; duplicate?: boolean }
  | { ok: false; error: ProposalError; message: string };

export interface ProposalServiceDeps {
  db: Database.Database;
  owners: Pick<OwnerDirectory, 'logicalAgentId' | 'ownerConversations'>;
  /** Protected paths per agent and the approved-hash registry (ProtectedPathMonitor). */
  protectedPaths: { paths(agentId: string): ProtectedPaths; noteApproved(path: string, hash: string): void };
  approvals: ApprovalStore;
  /** Put an approval request in front of its contact (dispatchApproval bound to the adapter registry). */
  dispatch: (request: ApprovalRequest, channel: string) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * A pending proposal went `stale` (the file changed since its base hash)
   * or `expired` (no answer in time). `conversationId` is the conversation
   * of its first approval request, when known. Wired to a `lapsed-proposal`
   * feedback event so the agent learns to re-propose if still relevant.
   */
  onLapsed?: (row: ProposalRow, reason: 'stale' | 'expired', conversationId: string | null) => void;
}

/** sha256 of UTF-8 text: the same digest `hashFile` gives the written file. */
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function evidenceList(evidence: ProposalInput['evidence']): string[] {
  const raw = evidence === undefined ? [] : Array.isArray(evidence) ? evidence : [evidence];
  return raw
    .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((e) => oneLine(e, MAX_EVIDENCE_ITEM));
}

export function parseEvidence(row: Pick<ProposalRow, 'evidence'>): string[] {
  if (!row.evidence) return [];
  try {
    const v = JSON.parse(row.evidence) as unknown;
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

/** Approval message body for a proposal: rationale, evidence and the compact diff. */
export function proposalDetails(row: Pick<ProposalRow, 'agent_id' | 'path' | 'rationale' | 'evidence' | 'diff'>): string {
  const evidence = parseEvidence(row);
  const diff = row.diff.length > DIFF_IN_APPROVAL ? `${row.diff.slice(0, DIFF_IN_APPROVAL)}\n… (diff cut)` : row.diff;
  return [
    `${row.agent_id.replace(/^agent:/, '')} wants to change ${row.path}.`,
    '',
    `Why: ${row.rationale.length > 800 ? `${row.rationale.slice(0, 799)}…` : row.rationale}`,
    ...(evidence.length > 0 ? ['', 'Evidence:', ...evidence.map((e) => `- ${e}`)] : []),
    '',
    diff,
  ].join('\n');
}

export class ProposalService {
  constructor(private readonly deps: ProposalServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  get(id: string): ProposalRow | null {
    return (this.deps.db.prepare('SELECT * FROM self_edit_proposals WHERE id = ?').get(id) as ProposalRow | undefined) ?? null;
  }

  list(filter: { agentId?: string; status?: ProposalStatus; limit?: number } = {}): ProposalRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.agentId) { where.push('agent_id = ?'); params.push(this.deps.owners.logicalAgentId(filter.agentId)); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    params.push(filter.limit ?? 50);
    return this.deps.db
      .prepare(`SELECT * FROM self_edit_proposals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as ProposalRow[];
  }

  /** Proposals that count toward the daily limit (everything except ones that never reached an owner). */
  private recentCount(agentId: string): number {
    const since = new Date(this.now().getTime() - 24 * 60 * 60 * 1000).toISOString();
    return (this.deps.db
      .prepare(`SELECT COUNT(*) AS n FROM self_edit_proposals WHERE agent_id = ? AND created_at > ? AND status != 'failed'`)
      .get(agentId, since) as { n: number }).n;
  }

  async submit(input: ProposalInput): Promise<SubmitResult> {
    const fail = (error: ProposalError, message: string): SubmitResult => ({ ok: false, error, message });
    const agentId = this.deps.owners.logicalAgentId(input.agentId);
    const paths = this.deps.protectedPaths.paths(agentId);
    if (paths.entries.length === 0) return fail('no_protected_paths', `${agentId} has no protected paths (no working directory or protected_paths: [])`);

    if (typeof input.path !== 'string' || input.path.trim() === '') return fail('invalid', 'path is required');
    if (!isAbsolute(input.path) && !paths.workingDir) return fail('invalid', 'path must be absolute: the agent has no working directory');
    const abs = resolvePath(isAbsolute(input.path) ? input.path : join(paths.workingDir!, input.path));
    if (!isProtectedPath(paths, abs)) {
      return fail('not_protected', `${input.path} is not a protected path. Edit memory files directly; propose changes only to ${paths.entries.map((e) => e.spec).join(', ')}.`);
    }
    const hasContent = typeof input.newContent === 'string';
    const hasDiff = typeof input.diff === 'string' && input.diff.trim() !== '';
    if (hasContent === hasDiff) return fail('invalid', 'give exactly one of new_content or diff');
    const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
    if (!rationale) return fail('invalid', 'rationale is required');

    let current: string | null;
    try {
      current = readFileSync(abs, 'utf-8');
    } catch {
      current = null;
    }
    const baseHash = hashFile(abs);
    let newContent: string;
    if (hasDiff) {
      try {
        newContent = applyUnifiedDiff(current ?? '', input.diff!);
      } catch (err) {
        return fail('diff_failed', `the diff does not apply to the current ${input.path}: ${err instanceof DiffApplyError ? err.message : String(err)}. Re-read the file and propose again, or send new_content.`);
      }
    } else {
      newContent = input.newContent!;
    }
    if (current !== null && newContent === current) return fail('no_change', 'the proposed content equals the current file');
    if (Buffer.byteLength(newContent, 'utf-8') > MAX_PROPOSAL_BYTES) return fail('too_large', `proposals are limited to ${MAX_PROPOSAL_BYTES / 1024} KB`);

    const newHash = sha(newContent);
    const duplicate = this.deps.db
      .prepare(`SELECT * FROM self_edit_proposals WHERE agent_id = ? AND abs_path = ? AND new_hash = ? AND status = 'pending'`)
      .get(agentId, abs, newHash) as ProposalRow | undefined;
    if (duplicate) return { ok: true, proposal: duplicate, notified: 0, duplicate: true };

    if (this.recentCount(agentId) >= MAX_PROPOSALS_PER_DAY) {
      return fail('rate_limited', `at most ${MAX_PROPOSALS_PER_DAY} proposals per agent per day; try again later`);
    }
    const owners = this.deps.owners.ownerConversations(agentId);
    if (owners.length === 0) return fail('no_owners', `${agentId} has no owners to approve proposals (agents.<id>.owners)`);

    const now = this.now();
    const shown = displayPath(paths, abs);
    const row: ProposalRow = {
      id: randomUUID(),
      agent_id: agentId,
      path: shown,
      abs_path: abs,
      base_hash: baseHash,
      new_content: newContent,
      new_hash: newHash,
      diff: compactDiff(current, newContent, { label: shown, maxChars: 8000 }),
      rationale: rationale.length > MAX_RATIONALE ? `${rationale.slice(0, MAX_RATIONALE - 1)}…` : rationale,
      evidence: JSON.stringify(evidenceList(input.evidence)),
      source: input.source,
      run_id: input.runId ?? null,
      status: 'pending',
      status_reason: null,
      approval_ids: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
      resolved_at: null,
      resolved_by: null,
    };
    this.deps.db
      .prepare(
        `INSERT INTO self_edit_proposals (id, agent_id, path, abs_path, base_hash, new_content, new_hash, diff, rationale, evidence,
           source, run_id, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(row.id, row.agent_id, row.path, row.abs_path, row.base_hash, row.new_content, row.new_hash, row.diff, row.rationale,
        row.evidence, row.source, row.run_id, row.created_at, row.expires_at);

    const details = proposalDetails(row);
    const ids: string[] = [];
    for (const owner of owners) {
      const request = this.deps.approvals.insert(
        {
          adapterId: SELF_EDIT_ADAPTER,
          agentId,
          conversationId: owner.conversationId,
          contactId: owner.contactId,
          toolName: PROPOSAL_TOOL_NAME,
          summary: `${shown}: ${oneLine(row.rationale, 160)}`,
          context: { proposal_id: row.id, details },
        },
        PROPOSAL_TTL_MS,
        now,
      );
      ids.push(request.id);
      try {
        await this.deps.dispatch(request, owner.channel);
      } catch (err) {
        this.deps.approvals.markStale(request.id, `dispatch failed: ${String(err)}`);
      }
    }
    this.deps.db.prepare('UPDATE self_edit_proposals SET approval_ids = ? WHERE id = ?').run(JSON.stringify(ids), row.id);
    const notified = ids.map((id) => this.deps.approvals.getById(id)).filter((r) => r?.status === 'pending' && r.notify_message_id).length;
    if (notified === 0) {
      this.setStatus(row.id, 'failed', 'no owner could be notified (owners need a channel with interactive approvals, e.g. Telegram)', 'system');
      return fail('not_delivered', 'no owner could be notified: owners need a channel with interactive approvals (Telegram)');
    }
    this.log(`[learning] proposal ${row.id.slice(0, 8)} from ${agentId}: ${shown} (${notified} owner(s) notified)`);
    return { ok: true, proposal: this.get(row.id)!, notified };
  }

  private setStatus(id: string, status: ProposalStatus, reason: string | null, by: string | null): boolean {
    return this.deps.db
      .prepare(`UPDATE self_edit_proposals SET status = ?, status_reason = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'`)
      .run(status, reason, this.now().toISOString(), by, id).changes > 0;
  }

  /** Tell `onLapsed` (never throws). `request` is the answering request, when there is one. */
  private lapsed(row: ProposalRow, reason: 'stale' | 'expired', request?: ApprovalRequest): void {
    if (!this.deps.onLapsed) return;
    try {
      let conversationId = request?.conversation_id ?? null;
      if (!conversationId) {
        let ids: string[] = [];
        try { ids = JSON.parse(row.approval_ids ?? '[]') as string[]; } catch { ids = []; }
        conversationId = ids.length > 0 ? this.deps.approvals.getById(ids[0]!)?.conversation_id ?? null : null;
      }
      this.deps.onLapsed(this.get(row.id) ?? row, reason, conversationId);
    } catch (err) {
      this.log(`[learning] proposal ${row.id.slice(0, 8)}: lapsed hook failed: ${String(err)}`);
    }
  }

  /** Mark the other owners' still-pending requests stale once one owner answered. */
  private closeSiblings(row: ProposalRow, answered: string, reason: string): void {
    let ids: string[] = [];
    try { ids = JSON.parse(row.approval_ids ?? '[]') as string[]; } catch { ids = []; }
    for (const id of ids) if (id !== answered) this.deps.approvals.markStale(id, reason);
  }

  /**
   * The `self-edit` backend for resolveApproval: apply or reject the
   * proposal behind an approval request. Returns `stale` (nothing done)
   * when the proposal is gone, answered, expired, or the file changed.
   */
  async decide(request: ApprovalRequest, decision: ApprovalDecision): Promise<{ result: 'resolved'; key: string } | { result: 'stale'; reason: string }> {
    let proposalId: string | null = null;
    try { proposalId = (JSON.parse(request.raw_context ?? '{}') as { proposal_id?: string }).proposal_id ?? null; } catch { proposalId = null; }
    const row = proposalId ? this.get(proposalId) : null;
    if (!row) return { result: 'stale', reason: 'proposal not found' };
    // Only the requests the bus raised for this proposal can answer it.
    let ids: string[] = [];
    try { ids = JSON.parse(row.approval_ids ?? '[]') as string[]; } catch { ids = []; }
    if (!ids.includes(request.id)) return { result: 'stale', reason: 'request does not belong to the proposal' };
    if (row.status !== 'pending') return { result: 'stale', reason: `proposal already ${row.status}` };
    const by = request.contact_id;
    if (row.expires_at < this.now().toISOString()) {
      if (this.setStatus(row.id, 'expired', 'no answer within 7 days', 'timeout')) this.lapsed(row, 'expired', request);
      return { result: 'stale', reason: 'proposal expired' };
    }
    if (decision === 'deny') {
      this.setStatus(row.id, 'denied', null, by);
      this.closeSiblings(row, request.id, `answered by ${by}: denied`);
      this.log(`[learning] proposal ${row.id.slice(0, 8)} (${row.path}) denied by ${by}`);
      return { result: 'resolved', key: 'denied' };
    }
    if (hashFile(row.abs_path) !== row.base_hash) {
      const reason = `${row.path} changed since the proposal was made; the agent may propose again`;
      const changed = this.setStatus(row.id, 'stale', reason, by);
      this.closeSiblings(row, request.id, reason);
      if (changed) this.lapsed(row, 'stale', request);
      return { result: 'stale', reason };
    }
    try {
      mkdirSync(dirname(row.abs_path), { recursive: true });
      const tmp = `${row.abs_path}.agentbus-${process.pid}-${Date.now()}.tmp`;
      writeFileSync(tmp, row.new_content, 'utf-8');
      renameSync(tmp, row.abs_path);
    } catch (err) {
      const reason = `could not write ${row.path}: ${err instanceof Error ? err.message : String(err)}`;
      this.setStatus(row.id, 'failed', reason, by);
      this.closeSiblings(row, request.id, reason);
      return { result: 'stale', reason };
    }
    this.deps.protectedPaths.noteApproved(row.abs_path, hashFile(row.abs_path));
    this.setStatus(row.id, 'applied', null, by);
    this.closeSiblings(row, request.id, `answered by ${by}: approved`);
    this.log(`[learning] proposal ${row.id.slice(0, 8)} applied to ${row.path} (approved by ${by})`);
    return { result: 'resolved', key: 'applied' };
  }

  /** Expire pending proposals past their deadline (the approval sweep expires their requests). Returns how many. */
  sweep(): number {
    const now = this.now().toISOString();
    const due = this.deps.db
      .prepare(`SELECT * FROM self_edit_proposals WHERE status = 'pending' AND expires_at < ?`)
      .all(now) as ProposalRow[];
    let expired = 0;
    for (const row of due) {
      if (!this.setStatus(row.id, 'expired', 'no answer within 7 days', 'timeout')) continue;
      expired += 1;
      this.lapsed(row, 'expired');
    }
    return expired;
  }
}
