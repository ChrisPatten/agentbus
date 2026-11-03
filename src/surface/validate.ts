/**
 * E96 S96.5 — validators for agent-published surface content.
 *
 * Pure functions: they turn what an agent sends (MCP tool arguments, relayed by
 * the publish routes) into the contract objects of `types.ts`, or throw a
 * {@link BoundsError} whose message is shown to the agent verbatim. Every
 * message names the field, what was wrong and the limit, so the agent can fix
 * the call without guessing.
 */
import {
  ACTION_ID_RE, BOUNDS, BoundsError, ID_RE, WIDGET_TYPE_RE,
  type ActionStyle, type Level, type NewJob, type SurfaceAction, type SurfaceEvent, type SurfaceSlot, type SurfaceWidget,
} from './types.js';

/** Where an event's action jobs are injected: the surface's followed conversation. */
export interface FollowTarget { contact: string; channel: string; topic?: string }

/** Default event lifetime when the agent sets no `expires_at`. */
export const DEFAULT_EVENT_TTL_MS = 24 * 3600_000;

const LEVELS: readonly Level[] = ['info', 'attention', 'urgent'];
const STYLES: readonly ActionStyle[] = ['default', 'primary', 'destructive'];
const COLOR_RE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|[a-z]{1,20})$/;
const ICON_RE = WIDGET_TYPE_RE;
const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;

const fail = (msg: string): never => { throw new BoundsError(msg); };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Removes control characters (keeping newlines when `multiline`), trims. */
function clean(v: string, multiline: boolean): string {
  const re = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return v.replace(re, multiline ? '' : ' ').trim();
}

function text(input: Record<string, unknown>, field: string, max: number, opts: { required: boolean; multiline?: boolean; label?: string }): string | undefined {
  const name = opts.label ?? field;
  const raw = input[field];
  if (raw === undefined || raw === null) {
    if (opts.required) fail(`${name} is required`);
    return undefined;
  }
  if (typeof raw !== 'string') fail(`${name} must be a string`);
  const v = clean(raw as string, opts.multiline ?? false);
  if (!v) {
    if (opts.required) fail(`${name} is empty`);
    return undefined;
  }
  const len = [...v].length;
  if (len > max) fail(`${name} is ${len} characters; the limit is ${max}`);
  return v;
}

function isoTime(input: Record<string, unknown>, field: string): string | undefined {
  const raw = input[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') fail(`${field} must be an ISO 8601 time string`);
  const ms = Date.parse(raw as string);
  if (Number.isNaN(ms)) fail(`${field} "${String(raw)}" is not a valid ISO 8601 time (e.g. 2026-11-03T14:30:00Z)`);
  return new Date(ms).toISOString();
}

function id(value: unknown, field: string, re: RegExp, max: number): string {
  if (typeof value !== 'string' || !re.test(value)) {
    fail(`${field} "${String(value)}" is invalid: use 1-${max} lowercase letters, digits, - or _, starting with a letter or digit`);
  }
  return value as string;
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface ValidateEventContext {
  follow: FollowTarget;
  /** Who publishes, e.g. `agent:peggy`. */
  source: string;
  now: number;
}

function validateAction(raw: unknown, index: number, ctx: ValidateEventContext, expiresAt: string): { action: SurfaceAction; job: NewJob } {
  const at = `actions[${index}]`;
  if (!isObject(raw)) fail(`${at} must be an object`);
  const a = raw as Record<string, unknown>;
  const actionId = id(a['id'], `${at}.id`, ACTION_ID_RE, 32);
  const label = text(a, 'label', BOUNDS.actionLabel, { required: true, label: `${at}.label` })!;
  let style: ActionStyle | undefined;
  if (a['style'] !== undefined) {
    if (!STYLES.includes(a['style'] as ActionStyle)) fail(`${at}.style must be one of ${STYLES.join(', ')}`);
    style = a['style'] as ActionStyle;
  }
  let confirm: SurfaceAction['confirm'];
  if (a['confirm'] !== undefined && a['confirm'] !== null) {
    if (!isObject(a['confirm'])) fail(`${at}.confirm must be an object with draft (and optional prompt)`);
    const c = a['confirm'] as Record<string, unknown>;
    const draft = text(c, 'draft', BOUNDS.draft, { required: true, multiline: true, label: `${at}.confirm.draft` })!;
    const prompt = text(c, 'prompt', BOUNDS.title, { required: false, label: `${at}.confirm.prompt` });
    confirm = { draft, ...(prompt ? { prompt } : {}) };
  }
  if (a['once'] !== undefined && typeof a['once'] !== 'boolean') fail(`${at}.once must be true or false`);
  const once = a['once'] === undefined ? true : (a['once'] as boolean);

  if (!isObject(a['run'])) fail(`${at}.run is required: { body: the message you receive when the button is tapped }`);
  const run = a['run'] as Record<string, unknown>;
  const body = text(run, 'body', BOUNDS.jobPayload, { required: true, multiline: true, label: `${at}.run.body` })!;
  if (run['sends_on_behalf'] !== undefined && typeof run['sends_on_behalf'] !== 'boolean') fail(`${at}.run.sends_on_behalf must be true or false`);
  const sendsOnBehalf = run['sends_on_behalf'] === true;
  if (sendsOnBehalf && !confirm) {
    fail(`${at}: run.sends_on_behalf is true, so confirm.draft is required (the exact text that will be sent, shown on the device before the tap fires)`);
  }

  const action: SurfaceAction = { id: actionId, label, ...(style ? { style } : {}), ...(confirm ? { confirm } : {}), once };
  const job: NewJob = {
    action_id: actionId,
    channel: ctx.follow.channel,
    sender: `contact:${ctx.follow.contact.replace(/^contact:/, '')}`,
    topic: ctx.follow.topic ?? 'general',
    payload_body: body,
    sends_on_behalf: sendsOnBehalf,
    confirm_draft: confirm?.draft ?? null,
    once,
    expires_at: expiresAt,
  };
  return { action, job };
}

/**
 * Validate an agent's event. Returns the event (with `created_at` = `updated_at` = now;
 * the caller keeps the stored `created_at` on update) and one job per action,
 * aimed at the surface's followed conversation and expiring with the event.
 */
export function validateEvent(input: unknown, ctx: ValidateEventContext): { event: SurfaceEvent; jobs: NewJob[] } {
  if (!isObject(input)) fail('event must be an object');
  const e = input as Record<string, unknown>;
  if (e['kind'] !== undefined && e['kind'] !== 'event') {
    fail(e['kind'] === 'approval'
      ? 'kind "approval" is created by the bus only; publish kind "event" (or omit kind)'
      : `kind must be "event"`);
  }
  const eventId = id(e['id'], 'id', ID_RE, 64);
  const title = text(e, 'title', BOUNDS.title, { required: true })!;
  const body = text(e, 'body', BOUNDS.body, { required: false, multiline: true });
  let level: Level = 'info';
  if (e['level'] !== undefined) {
    if (!LEVELS.includes(e['level'] as Level)) fail(`level must be one of ${LEVELS.join(', ')}`);
    level = e['level'] as Level;
  }
  const at = isoTime(e, 'at');
  const end = isoTime(e, 'end');
  if (end && !at) fail('end needs at (the start time)');
  if (at && end && Date.parse(end) < Date.parse(at)) fail('end is before at');

  const nowIso = new Date(ctx.now).toISOString();
  let expiresAt = isoTime(e, 'expires_at');
  if (expiresAt) {
    const ms = Date.parse(expiresAt);
    if (ms <= ctx.now) fail(`expires_at ${expiresAt} is not in the future (now is ${nowIso})`);
    if (ms > ctx.now + BOUNDS.eventMaxDays * DAY_MS) fail(`expires_at ${expiresAt} is more than ${BOUNDS.eventMaxDays} days ahead; the limit is ${BOUNDS.eventMaxDays} days`);
  } else {
    expiresAt = new Date(ctx.now + DEFAULT_EVENT_TTL_MS).toISOString();
  }

  const rawActions = e['actions'] ?? [];
  if (!Array.isArray(rawActions)) fail('actions must be an array');
  const list = rawActions as unknown[];
  if (list.length > BOUNDS.actionsPerObject) fail(`actions has ${list.length} buttons; the limit is ${BOUNDS.actionsPerObject}`);
  const actions: SurfaceAction[] = [];
  const jobs: NewJob[] = [];
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    const { action, job } = validateAction(raw, i, ctx, expiresAt!);
    if (seen.has(action.id)) fail(`actions[${i}].id "${action.id}" is used twice; action ids must be unique within the event`);
    seen.add(action.id);
    actions.push(action);
    jobs.push(job);
  });

  const event: SurfaceEvent = {
    id: eventId,
    kind: 'event',
    title,
    ...(body ? { body } : {}),
    level,
    ...(at ? { at } : {}),
    ...(end ? { end } : {}),
    expires_at: expiresAt,
    actions,
    source: ctx.source,
    created_at: nowIso,
    updated_at: nowIso,
  };
  return { event, jobs };
}

// ── Slots ────────────────────────────────────────────────────────────────────

export function validateSlot(input: unknown, ctx: { source: string; now: number }): SurfaceSlot {
  if (!isObject(input)) fail('slot must be an object');
  const s = input as Record<string, unknown>;
  const slotId = id(s['id'], 'slot', ID_RE, 64);
  const slotText = text(s, 'text', BOUNDS.slotText, { required: true })!;
  let icon: string | undefined;
  if (s['icon'] !== undefined && s['icon'] !== null && s['icon'] !== '') {
    if (typeof s['icon'] !== 'string' || !ICON_RE.test(s['icon'])) fail(`icon "${String(s['icon'])}" is invalid: use an icon name of 1-40 lowercase letters, digits, ., - or _`);
    icon = s['icon'] as string;
  }
  let color: string | undefined;
  if (s['color'] !== undefined && s['color'] !== null && s['color'] !== '') {
    if (typeof s['color'] !== 'string' || !COLOR_RE.test(s['color'])) fail(`color "${String(s['color'])}" is invalid: use #rgb, #rrggbb or a lowercase colour name`);
    color = s['color'] as string;
  }
  const until = isoTime(s, 'until');
  if (!until) fail(`until is required: the time the override ends (at most ${BOUNDS.slotMaxHours} hours ahead)`);
  const ms = Date.parse(until!);
  if (ms <= ctx.now) fail(`until ${until} is not in the future (now is ${new Date(ctx.now).toISOString()})`);
  if (ms > ctx.now + BOUNDS.slotMaxHours * HOUR_MS) fail(`until ${until} is more than ${BOUNDS.slotMaxHours} hours ahead; the limit is ${BOUNDS.slotMaxHours} hours`);
  return {
    id: slotId, text: slotText, ...(icon ? { icon } : {}), ...(color ? { color } : {}),
    until: until!, source: ctx.source, updated_at: new Date(ctx.now).toISOString(),
  };
}

// ── Widgets ──────────────────────────────────────────────────────────────────

export function validateWidget(input: unknown, ctx: { source: string; now: number }): SurfaceWidget {
  if (!isObject(input)) fail('widget must be an object');
  const w = input as Record<string, unknown>;
  const widgetId = id(w['id'], 'id', ID_RE, 64);
  if (typeof w['type'] !== 'string' || !WIDGET_TYPE_RE.test(w['type'])) {
    fail(`type "${String(w['type'])}" is invalid: use 1-40 lowercase letters, digits, ., - or _ (e.g. weather, countdown)`);
  }
  if (!isObject(w['data'])) fail('data must be a JSON object');
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(w['data']), 'utf8');
  } catch {
    return fail('data must be plain JSON');
  }
  if (size > BOUNDS.widgetDataBytes) fail(`data is ${size} bytes as JSON; the limit is ${BOUNDS.widgetDataBytes}`);
  return {
    id: widgetId, type: w['type'] as string, data: JSON.parse(JSON.stringify(w['data'])) as Record<string, unknown>,
    source: ctx.source, updated_at: new Date(ctx.now).toISOString(),
  };
}
