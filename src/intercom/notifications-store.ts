/**
 * E89 — SQLite storage and validation for user notifications.
 *
 * A notification is a short-lived "needs you soon" item. `key` is unique among
 * non-terminal rows (`active`, `acknowledged`), so a writer can upsert by key.
 * Terminal rows (`resolved`, `expired`) are deleted after the retention window.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export const TITLE_MAX = 60;
export const BODY_MAX = 280;
export const ACTION_LABEL_MAX = 24;
export const MAX_ACTIONS = 3;

export type NotificationLevel = 'info' | 'attention' | 'urgent';
export type NotificationState = 'active' | 'acknowledged' | 'resolved' | 'expired';
const LEVEL_RANK: Record<NotificationLevel, number> = { info: 1, attention: 2, urgent: 3 };

export interface NotificationAction { label: string; style?: 'primary' | 'success' | 'danger' }

export type ReplyMode = 'none' | 'voice' | 'choices' | 'both';
export type ReplyVia = 'voice' | 'choice' | 'skip';
export type ReplyState = 'none' | 'awaiting' | 'received' | 'skipped' | 'closed';

/** E105 — what a notification asks for. `context` is for the session only and is never sent to a device. */
export interface ReplyConfig { mode: ReplyMode; prompt?: string; context?: string; hints?: string[]; on_expire: 'note' | 'wake' }

/** E105 — where replies to a notification go. Stored as JSON in `conversation_ref`; never sent to a device. */
export interface ReplyBinding { conversation_id: string; channel: string; topic: string; contact: string }

export interface Notification {
  id: string;
  key: string | null;
  contact_id: string;
  title: string;
  body: string | null;
  level: NotificationLevel;
  state: NotificationState;
  targets: string[];
  actions: NotificationAction[];
  source: string;
  conversation_ref: string | null;
  acked_by: string | null;
  acked_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  reply: ReplyConfig | null;
  replied_at: string | null;
  reply_via: ReplyVia | null;
  resolution: string | null;
}

/** Cut to `max` characters, ending in "…" when something was removed. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

const ActionSchema = z.object({
  label: z.string().trim().min(1).max(ACTION_LABEL_MAX),
  style: z.enum(['primary', 'success', 'danger']).optional(),
});
const Title = z.string().trim().min(1).max(2000).transform((t) => truncate(t, TITLE_MAX));
const Body = z.string().trim().max(8000).transform((b) => truncate(b, BODY_MAX));
const Level = z.enum(['info', 'attention', 'urgent']);
const Targets = z.array(z.string().min(1).max(100)).min(1).max(20);
const ExpiresIn = z.number().int().positive().max(366 * 86_400);

export const REPLY_PROMPT_MAX = 80;
export const REPLY_CONTEXT_MAX = 600;
export const REPLY_HINTS_MAX = 8;
export const REPLY_HINT_LEN = 40;
export const REPLY_MAX_EXPIRES_S = 86_400;
export const RESOLUTION_MAX = 60;

const ReplySchema = z.object({
  mode: z.enum(['none', 'voice', 'choices', 'both']),
  prompt: z.string().trim().min(1).max(REPLY_PROMPT_MAX).optional(),
  context: z.string().trim().min(1).max(REPLY_CONTEXT_MAX).optional(),
  hints: z.array(z.string().trim().min(1).max(REPLY_HINT_LEN)).max(REPLY_HINTS_MAX).optional(),
  on_expire: z.enum(['note', 'wake']).optional(),
}).strict();
const Resolution = z.string().trim().min(1).max(2000).transform((r) => truncate(r, RESOLUTION_MAX));

export const NotifyInput = z.object({
  title: Title,
  body: Body.optional(),
  level: Level.optional(),
  key: z.string().trim().min(1).max(200).optional(),
  targets: Targets.optional(),
  expires_in_s: ExpiresIn.optional(),
  actions: z.array(ActionSchema).max(MAX_ACTIONS).optional(),
  source: z.string().trim().min(1).max(100),
  contact_id: z.string().trim().min(1).max(100).optional(),
  /** E105 — replies. With a mode other than none: a binding (conversation_id, or channel + topic) and `expires_in_s` (1..86400) are required. */
  reply: ReplySchema.optional(),
  conversation_id: z.string().trim().min(1).max(200).optional(),
  channel: z.string().trim().min(1).max(200).optional(),
  topic: z.string().trim().min(1).max(200).optional(),
  contact: z.string().trim().min(1).max(100).optional(),
}).strict().superRefine((v, ctx) => {
  const mode = v.reply?.mode ?? 'none';
  if (mode === 'none') return;
  if (v.expires_in_s === undefined || v.expires_in_s > REPLY_MAX_EXPIRES_S) {
    ctx.addIssue({ code: 'custom', path: ['expires_in_s'], message: `required with reply.mode ${mode}, at most ${REPLY_MAX_EXPIRES_S}` });
  }
  if ((mode === 'choices' || mode === 'both') && !(v.actions && v.actions.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['actions'], message: `reply.mode ${mode} needs at least one action` });
  }
});
export type NotifyInputT = z.infer<typeof NotifyInput>;

export const UpdateInput = z.object({
  id: z.string().min(1).max(100).optional(),
  key: z.string().trim().min(1).max(200).optional(),
  title: Title.optional(),
  body: Body.optional(),
  level: Level.optional(),
  state: z.enum(['resolved', 'acknowledged', 'active']).optional(),
  expires_in_s: ExpiresIn.optional(),
  resolution: Resolution.optional(),
}).strict();
export type UpdateInputT = z.infer<typeof UpdateInput>;

type Row = Omit<Notification, 'targets' | 'actions' | 'reply'> & { targets: string; actions: string; reply: string | null };
const fromRow = (r: Row): Notification => ({
  ...r, targets: JSON.parse(r.targets) as string[], actions: JSON.parse(r.actions) as NotificationAction[],
  reply: r.reply ? (JSON.parse(r.reply) as ReplyConfig) : null,
});

/** The reply binding stored in `conversation_ref`, or null (no binding, or a value that is not one). */
export function bindingOf(n: Pick<Notification, 'conversation_ref'>): ReplyBinding | null {
  if (!n.conversation_ref) return null;
  try {
    const b = JSON.parse(n.conversation_ref) as Partial<ReplyBinding>;
    return typeof b.conversation_id === 'string' && typeof b.channel === 'string' && typeof b.topic === 'string' && typeof b.contact === 'string'
      ? { conversation_id: b.conversation_id, channel: b.channel, topic: b.topic, contact: b.contact } : null;
  } catch { return null; }
}

/** The mode of a notification's reply config; `none` when it has none. */
export const replyMode = (n: Pick<Notification, 'reply'>): ReplyMode => n.reply?.mode ?? 'none';

export function replyState(n: Notification): ReplyState {
  if (replyMode(n) === 'none') return 'none';
  if (isTerminal(n)) return 'closed';
  if (n.reply_via === 'skip') return 'skipped';
  if (n.reply_via) return 'received';
  return 'awaiting';
}

export function getNotification(db: Database.Database, id: string): Notification | null {
  const r = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function findOpenByKey(db: Database.Database, key: string): Notification | null {
  const r = db.prepare(`SELECT * FROM notifications WHERE key = ? AND state IN ('active','acknowledged')`).get(key) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function isTerminal(n: Pick<Notification, 'state'>): boolean { return n.state === 'resolved' || n.state === 'expired'; }
export const targetsSurface = (n: Pick<Notification, 'targets'>, surfaceId: string): boolean => n.targets.includes('*') || n.targets.includes(surfaceId);

export interface WriteResult { notification: Notification; created: boolean; /** title, body or level changed (or created) */ contentChanged: boolean }

/**
 * Create, or update in place when `key` matches a non-terminal row. The result is `active`.
 * `binding` is where replies go (E105); a re-raise without `reply` and `binding` keeps the old ones, and always clears the reply outcome.
 */
export function upsertNotification(db: Database.Database, input: NotifyInputT, now = Date.now(), binding: ReplyBinding | null = null): WriteResult {
  const iso = new Date(now).toISOString();
  const expires = input.expires_in_s ? new Date(now + input.expires_in_s * 1000).toISOString() : undefined;
  const reply: ReplyConfig | null | undefined = input.reply && input.reply.mode !== 'none'
    ? { ...input.reply, on_expire: input.reply.on_expire ?? 'note' }
    : (input.reply ? null : undefined);
  return db.transaction((): WriteResult => {
    const existing = input.key ? findOpenByKey(db, input.key) : null;
    if (!existing) {
      const n: Notification = {
        id: randomUUID(), key: input.key ?? null, contact_id: input.contact_id ?? 'chris', title: input.title, body: input.body || null,
        level: input.level ?? 'attention', state: 'active', targets: input.targets ?? ['*'], actions: input.actions ?? [],
        source: input.source, conversation_ref: binding ? JSON.stringify(binding) : null, acked_by: null, acked_at: null,
        created_at: iso, updated_at: iso, expires_at: expires ?? null,
        reply: reply ?? null, replied_at: null, reply_via: null, resolution: null,
      };
      db.prepare(`INSERT INTO notifications(id,key,contact_id,title,body,level,state,targets,actions,source,conversation_ref,acked_by,acked_at,created_at,updated_at,expires_at,reply,replied_at,reply_via,resolution)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(n.id, n.key, n.contact_id, n.title, n.body, n.level, n.state, JSON.stringify(n.targets), JSON.stringify(n.actions),
        n.source, n.conversation_ref, null, null, iso, iso, n.expires_at, n.reply ? JSON.stringify(n.reply) : null, null, null, null);
      return { notification: n, created: true, contentChanged: true };
    }
    const next: Notification = {
      ...existing, title: input.title, body: input.body !== undefined ? (input.body || null) : existing.body,
      level: input.level ?? existing.level, state: 'active', targets: input.targets ?? existing.targets, actions: input.actions ?? existing.actions,
      source: input.source,
      conversation_ref: binding ? JSON.stringify(binding) : (reply === null ? null : existing.conversation_ref),
      acked_by: null, acked_at: null,
      updated_at: iso, expires_at: expires ?? existing.expires_at,
      reply: reply === undefined ? existing.reply : reply, replied_at: null, reply_via: null, resolution: null,
    };
    writeRow(db, next);
    const contentChanged = next.title !== existing.title || next.body !== existing.body || next.level !== existing.level;
    return { notification: next, created: false, contentChanged };
  })();
}

function writeRow(db: Database.Database, n: Notification): void {
  db.prepare(`UPDATE notifications SET title=?, body=?, level=?, state=?, targets=?, actions=?, source=?, conversation_ref=?, acked_by=?, acked_at=?, updated_at=?, expires_at=?, reply=?, replied_at=?, reply_via=?, resolution=? WHERE id=?`)
    .run(n.title, n.body, n.level, n.state, JSON.stringify(n.targets), JSON.stringify(n.actions), n.source, n.conversation_ref, n.acked_by, n.acked_at, n.updated_at, n.expires_at,
      n.reply ? JSON.stringify(n.reply) : null, n.replied_at, n.reply_via, n.resolution, n.id);
}

export type UpdateResult = WriteResult | { error: 'not_found' | 'terminal' | 'invalid' };

/** Patch a notification found by `id` or, among non-terminal rows, by `key`. A terminal row can only be left as it is. */
export function updateNotification(db: Database.Database, patch: UpdateInputT, now = Date.now()): UpdateResult {
  if (!patch.id && !patch.key) return { error: 'invalid' };
  const existing = patch.id ? getNotification(db, patch.id) : findOpenByKey(db, patch.key!);
  if (!existing) return { error: 'not_found' };
  if (isTerminal(existing)) return { error: 'terminal' };
  const iso = new Date(now).toISOString();
  const state = patch.state ?? existing.state;
  const next: Notification = {
    ...existing, title: patch.title ?? existing.title, body: patch.body !== undefined ? (patch.body || null) : existing.body,
    level: patch.level ?? existing.level, state, updated_at: iso,
    resolution: patch.resolution ?? existing.resolution,
    expires_at: patch.expires_in_s ? new Date(now + patch.expires_in_s * 1000).toISOString() : existing.expires_at,
    acked_by: state === 'acknowledged' ? (existing.acked_by ?? null) : (state === 'active' ? null : existing.acked_by),
    acked_at: state === 'acknowledged' ? (existing.acked_at ?? iso) : (state === 'active' ? null : existing.acked_at),
  };
  writeRow(db, next);
  const contentChanged = next.title !== existing.title || next.body !== existing.body || next.level !== existing.level;
  return { notification: next, created: false, contentChanged };
}

/** A surface acknowledges an active item. Returns the row (unchanged when already acknowledged), or null when missing or terminal. */
export function acknowledgeNotification(db: Database.Database, id: string, surfaceId: string, now = Date.now()): { notification: Notification; changed: boolean } | null {
  const n = getNotification(db, id);
  if (!n || isTerminal(n)) return null;
  if (n.state === 'acknowledged') return { notification: n, changed: false };
  const iso = new Date(now).toISOString();
  const next: Notification = { ...n, state: 'acknowledged', acked_by: surfaceId, acked_at: iso, updated_at: iso };
  writeRow(db, next);
  return { notification: next, changed: true };
}

export type StateFilter = 'active' | 'open' | 'all';

export function listNotifications(db: Database.Database, state: StateFilter = 'open', limit = 50): Notification[] {
  const where = state === 'active' ? `state = 'active'` : state === 'open' ? `state IN ('active','acknowledged')` : '1=1';
  const rows = db.prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(Math.max(1, Math.min(limit, 200))) as Row[];
  return rows.map(fromRow);
}

/** Open (`active` or `acknowledged`) notifications a surface should hold, oldest first. */
export function openForSurface(db: Database.Database, surfaceId: string): Notification[] {
  const rows = db.prepare(`SELECT * FROM notifications WHERE state IN ('active','acknowledged') ORDER BY updated_at, rowid`).all() as Row[];
  return rows.map(fromRow).filter((n) => targetsSurface(n, surfaceId));
}

export interface Attention { level: 'none' | NotificationLevel; count: number }

/** Highest level among the surface's `active` items, and how many there are. Acknowledged items do not count. */
export function attentionFor(db: Database.Database, surfaceId: string): Attention {
  let level: Attention['level'] = 'none';
  let count = 0;
  for (const n of openForSurface(db, surfaceId)) {
    if (n.state !== 'active') continue;
    count++;
    if (level === 'none' || LEVEL_RANK[n.level] > LEVEL_RANK[level]) level = n.level;
  }
  return { level, count };
}

/** `active` and `acknowledged` rows past `expires_at` become `expired`. Returns the changed rows. */
export function expireDue(db: Database.Database, now = Date.now()): Notification[] {
  const iso = new Date(now).toISOString();
  const rows = db.prepare(`SELECT * FROM notifications WHERE state IN ('active','acknowledged') AND expires_at IS NOT NULL AND expires_at <= ?`).all(iso) as Row[];
  const out: Notification[] = [];
  for (const r of rows) {
    const n = { ...fromRow(r), state: 'expired' as const, updated_at: iso };
    writeRow(db, n);
    out.push(n);
  }
  return out;
}

/** Resolved and expired rows older than the retention window are deleted. */
export function sweepNotifications(db: Database.Database, retentionDays: number, now = Date.now()): number {
  const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
  return db.prepare(`DELETE FROM notifications WHERE state IN ('resolved','expired') AND updated_at < ?`).run(cutoff).changes;
}

/** The wire shape sent to surfaces and returned by the API. */
export function publicNotification(n: Notification): Record<string, unknown> {
  return {
    id: n.id, key: n.key, title: n.title, body: n.body, level: n.level, state: n.state, actions: n.actions, source: n.source,
    created_at: n.created_at, updated_at: n.updated_at, expires_at: n.expires_at,
    reply: n.reply ? { mode: n.reply.mode, prompt: n.reply.prompt ?? null, hints: n.reply.hints ?? [], on_expire: n.reply.on_expire } : null,
    reply_state: replyState(n), replied_at: n.replied_at, reply_via: n.reply_via, resolution: n.resolution,
  };
}

/**
 * E105 — claim the single reply of an open reply-mode notification, atomically. Marks it `acknowledged` with `reply_via`
 * and `replied_at`. Returns the row and what it was before (for {@link releaseReply}), or why not: `already_replied`
 * (a reply or skip is already in), or `closed`.
 */
export function claimReply(db: Database.Database, id: string, via: ReplyVia, surfaceId: string, now = Date.now()): { notification: Notification; prev: Notification } | { error: 'already_replied' | 'closed' } {
  const prev = getNotification(db, id);
  if (!prev || isTerminal(prev)) return { error: 'closed' };
  const iso = new Date(now).toISOString();
  const res = db.prepare(`UPDATE notifications SET reply_via = ?, replied_at = ?, state = 'acknowledged', acked_by = COALESCE(acked_by, ?), acked_at = COALESCE(acked_at, ?), updated_at = ?
    WHERE id = ? AND reply_via IS NULL AND state IN ('active','acknowledged')`).run(via, iso, surfaceId, iso, iso, id);
  const n = getNotification(db, id);
  if (res.changes === 1 && n) return { notification: n, prev };
  return { error: 'already_replied' };
}

/** Undo a claim whose message never reached the session, so the device can try again. */
export function releaseReply(db: Database.Database, prev: Notification, now = Date.now()): Notification | null {
  db.prepare(`UPDATE notifications SET reply_via = NULL, replied_at = NULL, state = ?, acked_by = ?, acked_at = ?, updated_at = ? WHERE id = ? AND state IN ('active','acknowledged')`)
    .run(prev.state, prev.acked_by, prev.acked_at, new Date(now).toISOString(), prev.id);
  return getNotification(db, prev.id);
}
