import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { OwnerDirectory } from '../core/owners.js';
import { ApprovalStore } from '../approvals/store.js';
import { resolveApproval } from '../approvals/resolve.js';
import { renderApprovalPending } from '../approvals/render.js';
import type { ApprovalRequest } from '../approvals/types.js';
import { FeedbackStore } from '../journaling/feedback.js';
import { recordApprovalOutcome } from '../journaling/feedback-producers.js';
import { parseScriptOutput } from '../journaling/journalers/script.js';
import { ProtectedPathMonitor } from './monitor.js';
import { MAX_PROPOSALS_PER_DAY, PROPOSAL_TTL_MS, ProposalService, SELF_EDIT_ADAPTER } from './proposals.js';
import { hashFile } from './protected-paths.js';

let dir: string;
let db: Database.Database;
let clock: number;

function makeConfig(owners = [{ channel: 'telegram', contact_id: 'chris' }, { channel: 'telegram', contact_id: 'sam' }]): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    contacts: {
      chris: { id: 'chris', displayName: 'Chris', platforms: { telegram: { userId: 1 } } },
      sam: { id: 'sam', displayName: 'Sam', platforms: { telegram: { userId: 2 } } },
    },
    adapters: { 'cc-headless': { agent_id: 'baxter', system_prompt: 'x', working_dir: dir } },
    memory: {},
    agents: { 'agent:baxter': { owners, journaling: { chain: ['cc-headless'] } } },
  });
}

function setup(opts: { notify?: boolean; owners?: Parameters<typeof makeConfig>[0] } = {}) {
  const config = makeConfig(opts.owners);
  const resolver = new RuntimeResolver(config);
  const owners = new OwnerDirectory(config);
  const approvals = new ApprovalStore(db);
  const monitor = new ProtectedPathMonitor({ config, resolver, log: () => {} });
  const dispatch = vi.fn(async (request: ApprovalRequest, channel: string) => {
    if (opts.notify === false) approvals.markStale(request.id, `no adapter for ${channel}`);
    else approvals.updateNotify(request.id, channel, `${request.contact_id}:100`);
  });
  const service = new ProposalService({ db, owners, protectedPaths: monitor, approvals, dispatch, now: () => new Date(clock), log: () => {} });
  const feedback = new FeedbackStore(db, () => new Date(clock));
  const resolveDeps = {
    store: approvals, poolManagers: new Map(),
    backends: { [SELF_EDIT_ADAPTER]: (r: ApprovalRequest, d: 'approve' | 'deny') => service.decide(r, d) },
    onResolved: (r: ApprovalRequest, s: 'approved' | 'denied') =>
      recordApprovalOutcome({ db, feedback, logicalAgentId: (id) => owners.logicalAgentId(id) }, r, s),
  };
  return { service, approvals, monitor, dispatch, feedback, resolveDeps };
}

const proposal = { agentId: 'baxter', path: 'CLAUDE.md', rationale: 'Chris corrected the time format three times this week.', source: 'mcp' as const };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proposals-'));
  mkdirSync(join(dir, 'memory'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# Baxter\n- Use 12-hour time.\n');
  db = new Database(':memory:');
  runMigrations(db);
  clock = Date.UTC(2026, 9, 6, 12, 0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ProposalService.submit (S68.3)', () => {
  it('stores the proposal and sends each owner an Approve/Deny request with rationale and diff', async () => {
    const { service, approvals, dispatch } = setup();
    const r = await service.submit({ ...proposal, newContent: '# Baxter\n- Use 24-hour time.\n', evidence: ['2026-10-01 telegram', '2026-10-04 app'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notified).toBe(2);
    expect(r.proposal).toMatchObject({ agent_id: 'agent:baxter', path: 'CLAUDE.md', status: 'pending', base_hash: hashFile(join(dir, 'CLAUDE.md')) });
    expect(new Date(r.proposal.expires_at).getTime() - clock).toBe(PROPOSAL_TTL_MS);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const requests = approvals.list('pending');
    expect(requests.map((q) => q.contact_id).sort()).toEqual(['chris', 'sam']);
    const q = requests[0]!;
    expect(q).toMatchObject({ adapter_id: 'self-edit', agent_id: 'agent:baxter', tool_name: 'propose_change' });
    expect(q.summary).toMatch(/^CLAUDE\.md: Chris corrected/);
    const text = renderApprovalPending(q);
    expect(text).toContain('📝 Proposed change');
    expect(text).toContain('baxter wants to change CLAUDE.md.');
    expect(text).toContain('Why: Chris corrected');
    expect(text).toContain('- 2026-10-01 telegram');
    expect(text).toContain('-- Use 12-hour time.');
    expect(text).toContain('+- Use 24-hour time.');
    expect(text).toMatch(/answer by 2026-10-13 12:00 UTC/);
    // The file is untouched until an owner approves.
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# Baxter\n- Use 12-hour time.\n');
  });

  it('accepts a unified diff and rejects one that does not apply', async () => {
    const { service } = setup();
    const ok = await service.submit({ ...proposal, diff: '@@ -2,1 +2,1 @@\n-- Use 12-hour time.\n+- Use 24-hour time.' });
    expect(ok.ok && ok.proposal.new_content).toBe('# Baxter\n- Use 24-hour time.\n');
    const bad = await service.submit({ ...proposal, diff: '@@ -2,1 +2,1 @@\n-- Something else.\n+- x' });
    expect(bad).toMatchObject({ ok: false, error: 'diff_failed' });
  });

  it('validates the path, content and rationale', async () => {
    const { service } = setup();
    expect(await service.submit({ ...proposal, path: 'memory/MEMORY.md', newContent: 'x' })).toMatchObject({ ok: false, error: 'not_protected' });
    expect(await service.submit({ ...proposal, path: '../elsewhere/CLAUDE.md', newContent: 'x' })).toMatchObject({ ok: false, error: 'not_protected' });
    expect(await service.submit({ ...proposal })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await service.submit({ ...proposal, newContent: 'x', diff: '@@' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await service.submit({ ...proposal, rationale: ' ', newContent: 'x' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await service.submit({ ...proposal, newContent: '# Baxter\n- Use 12-hour time.\n' })).toMatchObject({ ok: false, error: 'no_change' });
    expect(await service.submit({ ...proposal, newContent: 'x'.repeat(300 * 1024) })).toMatchObject({ ok: false, error: 'too_large' });
    // A new skill file is fine: it is inside skills/.
    expect(await service.submit({ ...proposal, path: 'skills/time/SKILL.md', newContent: 'Use 24-hour time.\n' })).toMatchObject({ ok: true });
  });

  it('collapses an identical pending proposal and limits each agent to 3 a day', async () => {
    const { service } = setup();
    const first = await service.submit({ ...proposal, newContent: 'v1\n' });
    const again = await service.submit({ ...proposal, newContent: 'v1\n' });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(again.ok && first.ok && again.proposal.id).toBe(first.ok && first.proposal.id);
    for (let i = 2; i <= MAX_PROPOSALS_PER_DAY; i++) expect((await service.submit({ ...proposal, newContent: `v${i}\n` })).ok).toBe(true);
    expect(await service.submit({ ...proposal, newContent: 'v4\n' })).toMatchObject({ ok: false, error: 'rate_limited' });
    clock += 24 * 60 * 60 * 1000 + 1;
    expect((await service.submit({ ...proposal, newContent: 'v5\n' })).ok).toBe(true);
  });

  it('needs owners who can be notified', async () => {
    expect(await setup({ owners: [] }).service.submit({ ...proposal, newContent: 'x\n' })).toMatchObject({ ok: false, error: 'no_owners' });
    const { service } = setup({ notify: false });
    expect(await service.submit({ ...proposal, newContent: 'x\n' })).toMatchObject({ ok: false, error: 'not_delivered' });
    expect(service.list()[0]!.status).toBe('failed');
    // A proposal no owner saw doesn't count toward the daily limit.
    for (let i = 0; i < 3; i++) await service.submit({ ...proposal, newContent: `y${i}\n` });
    expect(service.list({ status: 'failed' })).toHaveLength(4);
  });
});

describe('resolving a proposal through the approval path (S68.3)', () => {
  it('approve: the bus applies the change, the other owner\'s request goes stale, and hashing does not flag it', async () => {
    const { service, approvals, monitor, resolveDeps, feedback } = setup();
    const r = await service.submit({ ...proposal, newContent: '# Baxter\n- Use 24-hour time.\n' });
    if (!r.ok) throw new Error('submit failed');
    const [chris, sam] = ['chris', 'sam'].map((c) => approvals.list('pending').find((q) => q.contact_id === c)!);
    const before = monitor.begin({ agentId: 'agent:baxter' } as never);
    const out = await resolveApproval(resolveDeps, chris!.id, 'approve', 'contact:chris', new Date(clock), 'chris');
    expect(out.outcome).toBe('approved');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# Baxter\n- Use 24-hour time.\n');
    expect(service.get(r.proposal.id)).toMatchObject({ status: 'applied', resolved_by: 'chris' });
    expect(approvals.getById(sam!.id)!.status).toBe('stale');
    expect(monitor.end({ agentId: 'agent:baxter', kind: 'session', runId: 'r' } as never, before, { attempts: [] } as never)).toEqual([]);
    expect(feedback.list()).toHaveLength(0);
    // The other owner can no longer answer.
    expect((await resolveApproval(resolveDeps, sam!.id, 'deny', 'contact:sam', new Date(clock), 'sam')).outcome).toBe('already_resolved');
  });

  it('approve after the file changed: the proposal is stale and nothing is written', async () => {
    const { service, approvals, resolveDeps } = setup();
    const r = await service.submit({ ...proposal, newContent: 'proposed\n' });
    if (!r.ok) throw new Error('submit failed');
    writeFileSync(join(dir, 'CLAUDE.md'), 'edited by the owner meanwhile\n');
    const q = approvals.list('pending')[0]!;
    const out = await resolveApproval(resolveDeps, q.id, 'approve', `contact:${q.contact_id}`, new Date(clock), q.contact_id);
    expect(out.outcome).toBe('stale');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('edited by the owner meanwhile\n');
    expect(service.get(r.proposal.id)).toMatchObject({ status: 'stale', status_reason: expect.stringContaining('changed since') });
    expect(approvals.list('pending')).toHaveLength(0);
  });

  it('approve creates a new file in a protected directory', async () => {
    const { service, approvals, resolveDeps } = setup({ owners: [{ channel: 'telegram', contact_id: 'chris' }] });
    const r = await service.submit({ ...proposal, path: 'skills/time/SKILL.md', newContent: 'Use 24-hour time.\n' });
    if (!r.ok) throw new Error('submit failed');
    expect(r.proposal.base_hash).toBe('absent');
    const q = approvals.list('pending')[0]!;
    await resolveApproval(resolveDeps, q.id, 'approve', 'contact:chris', new Date(clock), 'chris');
    expect(existsSync(join(dir, 'skills/time/SKILL.md'))).toBe(true);
  });

  it('deny: nothing is written and a denied-approval feedback event lands in the owner\'s conversation', async () => {
    const { service, approvals, resolveDeps, feedback } = setup();
    const r = await service.submit({ ...proposal, newContent: 'proposed\n' });
    if (!r.ok) throw new Error('submit failed');
    const q = approvals.list('pending').find((x) => x.contact_id === 'chris')!;
    expect((await resolveApproval(resolveDeps, q.id, 'deny', 'contact:chris', new Date(clock), 'chris')).outcome).toBe('denied');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# Baxter\n- Use 12-hour time.\n');
    expect(service.get(r.proposal.id)!.status).toBe('denied');
    const events = feedback.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'denied-approval', agent_id: 'agent:baxter', conversation_id: q.conversation_id, contact_id: 'chris' });
    expect(events[0]!.text).toMatch(/^Denied propose_change: CLAUDE\.md: Chris corrected/);
  });

  it('expires after 7 days', async () => {
    const { service, approvals, resolveDeps } = setup();
    const r = await service.submit({ ...proposal, newContent: 'proposed\n' });
    if (!r.ok) throw new Error('submit failed');
    clock += PROPOSAL_TTL_MS + 1000;
    const q = approvals.list('pending')[0]!;
    expect((await resolveApproval(resolveDeps, q.id, 'approve', `contact:${q.contact_id}`, new Date(clock), q.contact_id)).outcome).toBe('expired');
    expect(service.sweep()).toBe(1);
    expect(service.get(r.proposal.id)!.status).toBe('expired');
  });

  it('ignores an approval request that was not raised for the proposal', async () => {
    const { service, approvals } = setup();
    const r = await service.submit({ ...proposal, newContent: 'proposed\n' });
    if (!r.ok) throw new Error('submit failed');
    const forged = approvals.insert({ adapterId: 'self-edit', agentId: 'agent:baxter', contactId: 'chris', toolName: 'propose_change', summary: 'x', context: { proposal_id: r.proposal.id } }, 1000);
    expect(await service.decide(forged, 'approve')).toEqual({ result: 'stale', reason: 'request does not belong to the proposal' });
  });
});

describe('script proposals[] (S68.3)', () => {
  it('parses proposals from the script stdout JSON', () => {
    const out = parseScriptOutput(JSON.stringify({
      notes: 'ok',
      proposals: [
        { path: 'CLAUDE.md', diff: '@@ -1 +1 @@\n-a\n+b', rationale: 'why', evidence: ['2026-10-01'] },
        { path: 'x' },
        'junk',
      ],
    }));
    expect(out?.proposals).toEqual([{ path: 'CLAUDE.md', diff: '@@ -1 +1 @@\n-a\n+b', rationale: 'why', evidence: ['2026-10-01'] }]);
  });
});
