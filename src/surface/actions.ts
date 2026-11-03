/**
 * E96 S96.4 — actions and action-triggered jobs.
 *
 * A job is the scheduler's item shape with `trigger: 'action'`: it sits behind one
 * button of an Event (`events:<event id>:<action id>`) and, when a device taps that
 * button, its payload is injected into the inbound pipeline exactly as a scheduled
 * fire is. One handler ({@link createActionHandler}) serves `POST /api/v1/surface/actions`,
 * the WS `action` frame and (through `noticeAction`) E89 notification actions.
 *
 * Guarantees: a job never fires twice for one `(surface, idempotency_key)`, even for
 * concurrent duplicates; `once` jobs fire at most once across keys; nothing fires after
 * the job or its Event expires; a job that sends on Chris's behalf fires only when the
 * device echoes the exact `confirm.draft` the Event shows.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { InboundAbort, InboundMessage, InboundResult, InboundSystemOptions } from '../http/api.js';
import {
  ACTION_ID_RE, BOUNDS, BoundsError, ID_RE,
  type ActionHandler, type ActionResult, type ActionStatus, type Device, type JobStore,
  type NewJob, type ResourceHub, type SurfaceAction, type SurfaceJob,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;

// ── Job store ────────────────────────────────────────────────────────────────

interface JobRow {
  id: string; surface_id: string; object_ref: string; trigger: 'action'; channel: string; sender: string;
  topic: string; payload_body: string; sends_on_behalf: number; confirm_draft: string | null; once: number;
  expires_at: string | null; fire_count: number; last_fired_at: string | null; created_by: string; created_at: string;
}

function toJob(r: JobRow): SurfaceJob {
  return { ...r, sends_on_behalf: r.sends_on_behalf === 1, once: r.once === 1 };
}

export function jobObjectRef(eventId: string, actionId: string): string {
  return `events:${eventId}:${actionId}`;
}

/** The object ref of the button on a slot override (`slots:<slot id>:<action id>`). */
export function slotJobObjectRef(slotId: string, actionId: string): string {
  return `slots:${slotId}:${actionId}`;
}

type ObjectKind = 'events' | 'slots';

function validateJobs(kind: ObjectKind, objectId: string, jobs: NewJob[]): void {
  if (!ID_RE.test(objectId)) throw new BoundsError(`invalid ${kind === 'events' ? 'event' : 'slot'} id "${objectId}"`);
  const seen = new Set<string>();
  for (const j of jobs) {
    if (!ACTION_ID_RE.test(j.action_id)) throw new BoundsError(`invalid action id "${j.action_id}" (use [a-z0-9_-], at most 32 characters)`);
    if (seen.has(j.action_id)) throw new BoundsError(`duplicate action id "${j.action_id}"`);
    seen.add(j.action_id);
    if (!j.channel || !j.sender) throw new BoundsError(`action "${j.action_id}": channel and sender are required`);
    if (!j.payload_body || j.payload_body.length > BOUNDS.jobPayload) throw new BoundsError(`action "${j.action_id}": payload must be 1-${BOUNDS.jobPayload} characters`);
    if (j.confirm_draft !== null && (j.confirm_draft.length < 1 || j.confirm_draft.length > BOUNDS.draft)) throw new BoundsError(`action "${j.action_id}": confirm draft must be 1-${BOUNDS.draft} characters`);
    if (j.sends_on_behalf && j.confirm_draft === null) throw new BoundsError(`action "${j.action_id}" sends on Chris's behalf, so it needs confirm.draft (the exact text shown before it fires)`);
    if (j.expires_at !== null && Number.isNaN(Date.parse(j.expires_at))) throw new BoundsError(`action "${j.action_id}": expires_at is not a valid time`);
  }
}

/**
 * SQLite-backed {@link JobStore}. Replacing an Event's jobs keeps the id, `fire_count`
 * and `last_fired_at` of a job whose action id survives, so editing an Event cannot
 * re-arm a `once` button that already fired.
 */
export function createJobStore(db: Database.Database, now: () => number = Date.now): JobStore {
  const prefixWhere = `surface_id = ? AND substr(object_ref, 1, ?) = ?`;
  const selectForEvent = db.prepare(`SELECT * FROM surface_jobs WHERE ${prefixWhere}`);
  const deleteForEvent = db.prepare(`DELETE FROM surface_jobs WHERE ${prefixWhere}`);
  const insert = db.prepare(
    `INSERT INTO surface_jobs (id, surface_id, object_ref, trigger, channel, sender, topic, payload_body, sends_on_behalf,
       confirm_draft, once, expires_at, fire_count, last_fired_at, created_by, created_at)
     VALUES (@id, @surface_id, @object_ref, 'action', @channel, @sender, @topic, @payload_body, @sends_on_behalf,
       @confirm_draft, @once, @expires_at, @fire_count, @last_fired_at, @created_by, @created_at)`,
  );
  const selectOne = db.prepare(`SELECT * FROM surface_jobs WHERE surface_id = ? AND object_ref = ?`);

  const replace = db.transaction((kind: ObjectKind, surfaceId: string, eventId: string, jobs: NewJob[], createdBy: string): SurfaceJob[] => {
    const prefix = `${kind}:${eventId}:`;
    const previous = new Map((selectForEvent.all(surfaceId, prefix.length, prefix) as JobRow[]).map((r) => [r.object_ref, r]));
    deleteForEvent.run(surfaceId, prefix.length, prefix);
    const at = new Date(now()).toISOString();
    const out: SurfaceJob[] = [];
    for (const j of jobs) {
      const objectRef = `${kind}:${eventId}:${j.action_id}`;
      const prev = previous.get(objectRef);
      const row: JobRow = {
        id: prev?.id ?? randomUUID(), surface_id: surfaceId, object_ref: objectRef, trigger: 'action',
        channel: j.channel, sender: j.sender, topic: j.topic ?? 'general', payload_body: j.payload_body,
        sends_on_behalf: j.sends_on_behalf ? 1 : 0, confirm_draft: j.confirm_draft, once: j.once ? 1 : 0,
        expires_at: j.expires_at, fire_count: prev?.fire_count ?? 0, last_fired_at: prev?.last_fired_at ?? null,
        created_by: createdBy, created_at: prev?.created_at ?? at,
      };
      insert.run(row);
      out.push(toJob(row));
    }
    return out;
  });

  return {
    replaceForEvent(surfaceId, eventId, jobs, createdBy) {
      validateJobs('events', eventId, jobs);
      return replace('events', surfaceId, eventId, jobs, createdBy);
    },
    removeForEvent(surfaceId, eventId) {
      const prefix = `events:${eventId}:`;
      return deleteForEvent.run(surfaceId, prefix.length, prefix).changes;
    },
    replaceForSlot(surfaceId, slotId, jobs, createdBy) {
      validateJobs('slots', slotId, jobs);
      return replace('slots', surfaceId, slotId, jobs, createdBy);
    },
    removeForSlot(surfaceId, slotId) {
      const prefix = `slots:${slotId}:`;
      return deleteForEvent.run(surfaceId, prefix.length, prefix).changes;
    },
    get(surfaceId, objectRef) {
      const r = selectOne.get(surfaceId, objectRef) as JobRow | undefined;
      return r ? toJob(r) : null;
    },
  };
}

/**
 * Housekeeping: delete jobs whose `expires_at` passed more than a day ago (the day of
 * grace lets a late tap still answer `expired` instead of `not_found`) and idempotency
 * keys older than `keyTtlHours`.
 */
export function sweepJobs(db: Database.Database, now: number = Date.now(), keyTtlHours = 48): { jobs: number; keys: number } {
  const jobs = db.prepare(`DELETE FROM surface_jobs WHERE expires_at IS NOT NULL AND julianday(expires_at) < julianday(?)`)
    .run(new Date(now - DAY_MS).toISOString()).changes;
  const keys = db.prepare(`DELETE FROM surface_action_keys WHERE created_at < ?`)
    .run(new Date(now - keyTtlHours * 3_600_000).toISOString()).changes;
  return { jobs, keys };
}

// ── Action handler ───────────────────────────────────────────────────────────

export interface ActionHandlerDeps {
  db: Database.Database;
  hub: Pick<ResourceHub, 'get'>;
  jobs: JobStore;
  /** The bus inbound pipeline (`processInbound` bound to its deps), as the scheduler uses it. */
  submitInbound: (msg: InboundMessage, system?: InboundSystemOptions) => Promise<InboundResult | InboundAbort>;
  rateLimitPerMin: number;
  keyTtlHours: number;
  now?: () => number;
  log?: (msg: string) => void;
  /** E89 notification action (`notices:<id>`, action ids `"0"`, `"1"`, ... index into its actions). */
  noticeAction?: (device: Device, noticeId: string, actionId: string, idempotencyKey: string) => Promise<ActionResult>;
  /**
   * `conversations:<conversation id>`: tap choice button `index` (`action_id`) of an open prompt in that
   * conversation (the one on `messageId`, else the newest). Behaves like a Telegram tap.
   */
  conversationAction?: (device: Device, conversationId: string, index: number, messageId: string | undefined, idempotencyKey: string) => Promise<ActionResult>;
  /** Approve/Deny on an `approval` Event whose id is `approval-<approvalId>`. */
  approvalAction?: (device: Device, approvalId: string, decision: 'approve' | 'deny', idempotencyKey: string) => Promise<ActionResult>;
}

const ActionRequestSchema = z.object({
  object: z.string().regex(/^((events|notices|slots):[^:\s]{1,128}|conversations:[A-Za-z0-9_:-]{1,128})$/),
  action_id: z.string().regex(ACTION_ID_RE),
  idempotency_key: z.string().min(1).max(BOUNDS.idemKey),
  draft: z.string().max(BOUNDS.draft).optional(),
  message_id: z.string().min(1).max(128).optional(),
});

const INDEX_ACTION_RE = /^(0|[1-9]\d{0,2})$/;
const APPROVAL_PREFIX = 'approval-';

function result(key: string, status: ActionStatus, extra: { reason?: string; message_id?: string } = {}): ActionResult {
  return { type: 'action_result', idempotency_key: key, status, ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.message_id ? { message_id: extra.message_id } : {}) };
}

const failed = (key: string, reason: string): ActionResult => result(key, 'failed', { reason });

function isPast(iso: unknown, now: number): boolean {
  if (typeof iso !== 'string') return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t <= now;
}

/** Thrown internally to stop processing with a result that must not be stored. */
class Transient extends Error {}

export function createActionHandler(deps: ActionHandlerDeps): ActionHandler {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(`[surface-actions] ${m}`));
  const db = deps.db;
  const locks = new Map<string, Promise<void>>();
  const hits = new Map<string, number[]>();

  const getKey = db.prepare(`SELECT result_json, created_at FROM surface_action_keys WHERE surface_id = ? AND idempotency_key = ?`);
  const putKey = db.prepare(
    `INSERT OR REPLACE INTO surface_action_keys (surface_id, idempotency_key, device_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const claimJob = db.prepare(
    `UPDATE surface_jobs SET fire_count = fire_count + 1, last_fired_at = ? WHERE id = ? AND (once = 0 OR fire_count = 0)`,
  );
  const unclaimJob = db.prepare(`UPDATE surface_jobs SET fire_count = MAX(fire_count - 1, 0), last_fired_at = ? WHERE id = ?`);

  /** Sliding-window limit per device. */
  function allowed(deviceId: string): boolean {
    const t = now();
    const recent = (hits.get(deviceId) ?? []).filter((h) => t - h < RATE_WINDOW_MS);
    if (recent.length >= deps.rateLimitPerMin) { hits.set(deviceId, recent); return false; }
    recent.push(t);
    hits.set(deviceId, recent);
    if (hits.size > 1000) for (const [k, v] of hits) if (v.every((h) => t - h >= RATE_WINDOW_MS)) hits.delete(k);
    return true;
  }

  /** A remembered answer for this key, or null (absent or older than the TTL). */
  function remembered(surfaceId: string, key: string): ActionResult | null {
    const row = getKey.get(surfaceId, key) as { result_json: string; created_at: string } | undefined;
    if (!row) return null;
    if (Date.parse(row.created_at) < now() - deps.keyTtlHours * 3_600_000) return null;
    const first = JSON.parse(row.result_json) as ActionResult;
    // A repeat of a tap that fired answers already_done; a repeat of any other outcome replays it.
    if (first.status === 'done' || first.status === 'already_done') {
      return result(key, 'already_done', first.message_id ? { message_id: first.message_id } : {});
    }
    return first;
  }

  /** Check-then-insert in one transaction: stores `res` unless another request already answered this key. */
  const store = db.transaction((device: Device, key: string, res: ActionResult): ActionResult => {
    const prior = remembered(device.surface_id, key);
    if (prior) return prior;
    putKey.run(device.surface_id, key, device.id, JSON.stringify(res), new Date(now()).toISOString());
    return res;
  });

  /** Claim the job in the same transaction as the key check, so neither a duplicate key nor a second `once` tap can fire it. */
  const claim = db.transaction((device: Device, key: string, job: SurfaceJob): ActionResult | 'claimed' => {
    const prior = remembered(device.surface_id, key);
    if (prior) return prior;
    if (claimJob.run(new Date(now()).toISOString(), job.id).changes === 0) {
      return store(device, key, result(key, 'already_done'));
    }
    return 'claimed';
  });

  async function delegated(device: Device, key: string, run: () => Promise<ActionResult>): Promise<ActionResult> {
    let res: ActionResult;
    try {
      res = { ...(await run()), type: 'action_result', idempotency_key: key };
    } catch (err) {
      log(`delegated action failed: ${String(err)}`);
      return failed(key, 'internal_error');
    }
    if (res.status === 'failed' && res.reason === 'internal_error') return res;   // retryable: not stored
    return store(device, key, res);
  }

  async function fire(device: Device, key: string, req: z.infer<typeof ActionRequestSchema>, kind: ObjectKind, eventId: string): Promise<ActionResult> {
    const t = now();
    const ref = `${kind}:${eventId}:${req.action_id}`;
    const event = deps.hub.get(device.surface_id, kind, eventId);
    const job = deps.jobs.get(device.surface_id, ref);

    if (!event) {
      return store(device, key, job && isPast(job.expires_at, t) ? result(key, 'expired') : failed(key, 'not_found'));
    }
    // An Event has up to three buttons; a slot override has at most one (`action`).
    const actions = kind === 'events'
      ? (Array.isArray(event['actions']) ? (event['actions'] as SurfaceAction[]) : [])
      : (event['action'] && typeof event['action'] === 'object' ? [event['action'] as SurfaceAction] : []);
    const action = actions.find((a) => a && a.id === req.action_id);
    if (!job || !action) {
      return store(device, key, job && isPast(job.expires_at, t) ? result(key, 'expired') : failed(key, 'not_found'));
    }
    if (isPast(job.expires_at, t) || isPast(event[kind === 'events' ? 'expires_at' : 'until'], t)) return store(device, key, result(key, 'expired'));
    if (job.once && job.fire_count > 0) return store(device, key, result(key, 'already_done'));

    // confirm.draft: the job's stored draft and the one the device shows must agree, and the device must echo it.
    const shownDraft = typeof action.confirm?.draft === 'string' ? action.confirm.draft : null;
    if (job.sends_on_behalf && (job.confirm_draft === null || shownDraft === null || job.confirm_draft !== shownDraft)) {
      log(`refusing ${ref}: sends on behalf without a matching confirm.draft on the event`);
      return store(device, key, failed(key, 'confirm_required'));
    }
    if (job.confirm_draft !== null && shownDraft !== null && job.confirm_draft !== shownDraft) {
      return store(device, key, failed(key, 'confirm_required'));
    }
    const required = job.confirm_draft ?? shownDraft;
    if (required !== null) {
      if (req.draft === undefined) return store(device, key, failed(key, 'confirm_required'));
      if (req.draft !== required) return store(device, key, failed(key, 'draft_mismatch'));
    }

    const claimed = claim(device, key, job);
    if (claimed !== 'claimed') return claimed;

    const messageId = randomUUID();
    const msg: InboundMessage = {
      id: messageId,
      channel: job.channel,
      sender: job.sender,
      topic: job.topic,
      payload: { type: 'text', body: job.payload_body },
      metadata: {
        origin: 'surface_action', surface_id: device.surface_id, device_id: device.id,
        object: req.object, action_id: req.action_id, job_id: job.id, idempotency_key: key,
      },
    };
    let out: InboundResult | InboundAbort;
    try {
      out = await deps.submitInbound(msg);
    } catch (err) {
      log(`submitInbound failed for ${ref}: ${String(err)}`);
      unclaimJob.run(job.last_fired_at, job.id);                                 // not fired: the same key may retry
      throw new Transient();
    }
    let res: ActionResult;
    if (out.queued) {
      res = out.enqueued_count > 0 ? result(key, 'done', { message_id: out.id || messageId }) : failed(key, 'no_route');
    } else {
      res = out.reason === 'command_handled' ? result(key, 'done', { message_id: messageId }) : failed(key, out.reason || 'rejected');
    }
    putKey.run(device.surface_id, key, device.id, JSON.stringify(res), new Date(now()).toISOString());
    return res;
  }

  async function process(device: Device, req: z.infer<typeof ActionRequestSchema>): Promise<ActionResult> {
    const key = req.idempotency_key;
    const prior = remembered(device.surface_id, key);
    if (prior) return prior;

    const sep = req.object.indexOf(':');
    const kind = req.object.slice(0, sep);
    const id = req.object.slice(sep + 1);

    if (kind === 'conversations') {
      if (!INDEX_ACTION_RE.test(req.action_id)) return store(device, key, failed(key, 'invalid'));
      const convo = deps.conversationAction;
      if (!convo) return store(device, key, failed(key, 'not_found'));
      return delegated(device, key, () => convo(device, id, Number(req.action_id), req.message_id, key));
    }

    if (kind === 'notices') {
      if (!INDEX_ACTION_RE.test(req.action_id)) return store(device, key, failed(key, 'invalid'));
      const notice = deps.noticeAction;
      if (!notice) return store(device, key, failed(key, 'not_found'));
      return delegated(device, key, () => notice(device, id, req.action_id, key));
    }

    if (kind === 'events' && id.startsWith(APPROVAL_PREFIX) && (req.action_id === 'approve' || req.action_id === 'deny')) {
      const event = deps.hub.get(device.surface_id, 'events', id);
      if (event && event['kind'] === 'approval') {
        const approval = deps.approvalAction;
        if (!approval) return store(device, key, failed(key, 'not_found'));
        if (isPast(event['expires_at'], now())) return store(device, key, result(key, 'expired'));
        const decision = req.action_id;
        return delegated(device, key, () => approval(device, id.slice(APPROVAL_PREFIX.length), decision, key));
      }
    }

    return fire(device, key, req, kind === 'slots' ? 'slots' : 'events', id);
  }

  return {
    async handle(device, raw) {
      const parsed = ActionRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const k = raw && typeof raw === 'object' ? (raw as { idempotency_key?: unknown }).idempotency_key : undefined;
        return failed(typeof k === 'string' && k.length <= BOUNDS.idemKey ? k : '', 'invalid');
      }
      const req = parsed.data;
      const key = req.idempotency_key;
      if (device.scope === 'read_only') return failed(key, 'read_only');
      if (!allowed(device.id)) return failed(key, 'rate_limited');

      // Serialise per (surface, key): a concurrent duplicate waits, then sees the stored answer.
      const lockKey = `${device.surface_id}\u0000${key}`;
      while (locks.has(lockKey)) await locks.get(lockKey);
      let release!: () => void;
      locks.set(lockKey, new Promise<void>((r) => { release = r; }));
      try {
        return await process(device, req);
      } catch (err) {
        if (!(err instanceof Transient)) log(`action ${req.object}/${req.action_id} failed: ${String(err)}`);
        return failed(key, 'internal_error');
      } finally {
        locks.delete(lockKey);
        release();
      }
    },
  };
}
