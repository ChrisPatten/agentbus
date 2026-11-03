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
  ACTION_ID_RE, BOUNDS, BoundsError, COLOR_PALETTE, ID_RE, TRAVEL_MODES, WIDGET_TYPE_RE,
  type ActionStyle, type EventDetail, type EventLayer, type EventOpens, type EventTravel, type FaceLayout, type Level, type NewJob,
  type SurfaceAction, type SurfaceEvent, type SurfaceSlot, type SurfaceWidget, type TravelMode,
} from './types.js';

/** Where an event's action jobs are injected: the surface's followed conversation. */
export interface FollowTarget { contact: string; channel: string; topic?: string }

/** Default event lifetime when the agent sets no `expires_at`. */
export const DEFAULT_EVENT_TTL_MS = 24 * 3600_000;

const LEVELS: readonly Level[] = ['info', 'attention', 'urgent'];
const STYLES: readonly ActionStyle[] = ['default', 'primary', 'destructive'];
const COLOR_RE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|[a-z]{1,20})$/;
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ASSET_HASH_RE = /^[0-9a-f]{64}$/;
const CONVERSATION_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;
const LAYERS: readonly EventLayer[] = ['primary', 'overlap'];
const OPENS: readonly EventOpens[] = ['focus', 'conversation'];
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

function enumField<T extends string>(input: Record<string, unknown>, field: string, allowed: readonly T[]): T | undefined {
  const raw = input[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (!allowed.includes(raw as T)) fail(`${field} must be one of ${allowed.join(', ')}`);
  return raw as T;
}

/** `#rgb`, `#rrggbb` or a palette name (lowercased). */
function eventColor(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') fail('color must be a string');
  const c = (raw as string).trim();
  if (HEX_COLOR_RE.test(c)) return c.toLowerCase();
  if ((COLOR_PALETTE as readonly string[]).includes(c.toLowerCase())) return c.toLowerCase();
  return fail(`color "${c}" is invalid: use #rgb, #rrggbb or one of ${COLOR_PALETTE.join(', ')}`);
}

function eventTravel(raw: unknown): EventTravel | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) fail('travel must be an object: { minutes, mode? }');
  const t = raw as Record<string, unknown>;
  const minutes = t['minutes'];
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > BOUNDS.travelMinutes) {
    fail(`travel.minutes must be a whole number from 1 to ${BOUNDS.travelMinutes}`);
  }
  let mode: TravelMode | undefined;
  if (t['mode'] !== undefined && t['mode'] !== null) {
    if (!TRAVEL_MODES.includes(t['mode'] as TravelMode)) fail(`travel.mode must be one of ${TRAVEL_MODES.join(', ')}`);
    mode = t['mode'] as TravelMode;
  }
  return { minutes: minutes as number, ...(mode ? { mode } : {}) };
}

/** The focus view's content. `image` is an asset hash (64 hex, optionally written `asset:<hash>`). */
function eventDetail(raw: unknown): EventDetail | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) fail('detail must be an object: { description?, location?, image? }');
  const d = raw as Record<string, unknown>;
  const description = text(d, 'description', BOUNDS.description, { required: false, multiline: true, label: 'detail.description' });
  const location = text(d, 'location', BOUNDS.location, { required: false, label: 'detail.location' });
  let image: string | undefined;
  if (d['image'] !== undefined && d['image'] !== null && d['image'] !== '') {
    const m = typeof d['image'] === 'string' ? /^(?:asset:)?([0-9a-fA-F]{64})$/.exec(d['image']) : null;
    if (!m) fail('detail.image must be an asset hash: 64 hex characters (sha256), optionally written asset:<hash>; upload the file first');
    image = m![1]!.toLowerCase();
  }
  const out: EventDetail = { ...(description ? { description } : {}), ...(location ? { location } : {}), ...(image ? { image } : {}) };
  return Object.keys(out).length ? out : undefined;
}

/** True when the event is drawn on the Day Dial ring: a `kind: 'event'` with both `at` and `end`. Approvals never are. */
export function drawsOnRing(e: { kind?: unknown; at?: unknown; end?: unknown }): boolean {
  return e.kind === 'event' && typeof e.at === 'string' && typeof e.end === 'string';
}

/**
 * The ring holds at most {@link BOUNDS.ringPrimary} `primary` and {@link BOUNDS.ringOverlap} `overlap` events at
 * any one moment. Throws a {@link BoundsError} naming the clash when adding `event` to `existing` (live ring
 * events; the event's own id is ignored) would break that. Non-ring events pass.
 */
export function checkRingCapacity(existing: readonly Record<string, unknown>[], event: Pick<SurfaceEvent, 'id' | 'kind' | 'at' | 'end' | 'layer'>, now: number): void {
  if (!drawsOnRing(event)) return;
  const layer: EventLayer = event.layer ?? 'primary';
  const limit = layer === 'primary' ? BOUNDS.ringPrimary : BOUNDS.ringOverlap;
  const start = Date.parse(event.at!);
  const stop = Date.parse(event.end!);
  const peers = existing.filter((o) => o['id'] !== event.id && drawsOnRing(o) && ((o['layer'] as EventLayer | undefined) ?? 'primary') === layer
    && !(typeof o['expires_at'] === 'string' && Date.parse(o['expires_at']) <= now));
  const spans = peers
    .map((o) => ({ id: String(o['id']), a: Date.parse(o['at'] as string), b: Date.parse(o['end'] as string) }))
    .filter((o) => o.a < stop && o.b > start);
  // Sweep over the new event's interval: max concurrency among the clashing peers plus the new one.
  const points = [start, ...spans.map((o) => o.a).filter((t) => t > start)];
  for (const t of points) {
    const live = spans.filter((o) => o.a <= t && o.b > t);
    if (live.length + 1 > limit) {
      fail(`the ring would hold ${live.length + 1} "${layer}" events at once (limit ${limit}); `
        + `it overlaps ${live.map((o) => `"${o.id}"`).join(', ')}. Move it, shorten it, or remove one first`);
    }
  }
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface ValidateEventContext {
  follow: FollowTarget;
  /** Who publishes, e.g. `agent:peggy`. */
  source: string;
  now: number;
}

/** Validate one button and build the job behind it. `at` names the field in errors (`actions[0]`, `action`). */
export function validateAction(raw: unknown, index: number | string, ctx: ValidateEventContext, expiresAt: string): { action: SurfaceAction; job: NewJob } {
  const at = typeof index === 'number' ? `actions[${index}]` : index;
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

  const layer = enumField(e, 'layer', LAYERS);
  const color = eventColor(e['color']);
  const travel = eventTravel(e['travel']);
  const detail = eventDetail(e['detail']);
  const opens = enumField(e, 'opens', OPENS);
  let conversationId: string | undefined;
  if (e['conversation_id'] !== undefined && e['conversation_id'] !== null && e['conversation_id'] !== '') {
    if (typeof e['conversation_id'] !== 'string' || !CONVERSATION_ID_RE.test(e['conversation_id'])) {
      fail('conversation_id is invalid: use the id of a conversation (1-128 letters, digits, - _ or :), e.g. from the sessions resource');
    }
    conversationId = e['conversation_id'] as string;
  }
  if (opens === 'conversation' && !conversationId) fail('opens "conversation" needs conversation_id (the conversation the tap opens)');
  if (conversationId && opens !== 'conversation') fail('conversation_id is only used with opens "conversation"');
  if (layer && !(at && end)) fail('layer needs both at and end: only an event with a start and an end is drawn on the ring');
  if ((color || travel) && !(at && end)) fail(`${color ? 'color' : 'travel'} needs both at and end (it is part of the ring segment)`);

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
    ...(layer ? { layer } : {}),
    ...(color ? { color } : {}),
    ...(travel ? { travel } : {}),
    ...(detail ? { detail } : {}),
    ...(opens ? { opens } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    expires_at: expiresAt,
    actions,
    source: ctx.source,
    created_at: nowIso,
    updated_at: nowIso,
  };
  return { event, jobs };
}

// ── Slots ────────────────────────────────────────────────────────────────────

export interface ValidateSlotContext {
  source: string;
  now: number;
  /** Required to validate a slot with an `action` (the job aims at the followed conversation). */
  follow?: FollowTarget;
  /** Whether a widget with this id exists on the surface. Without it widget ids are checked for shape only. */
  widgetExists?: (id: string) => boolean;
}

/** Slot names the bus gives meaning to. Other names are accepted as plain text overrides. */
export const SLOT_PRIMARY = 'primary';
export const SLOT_CONTEXT = 'context';

/**
 * Validate a slot override. `primary` may carry one `action` button; `context` carries either `lines`
 * (at most 2) or `widgets` (at most 3 existing widget ids); any other slot is `text` only. Returns the
 * slot and, for a primary slot with an action, the job behind its button (expiring with the slot).
 */
export function validateSlot(input: unknown, ctx: ValidateSlotContext): SurfaceSlot;
export function validateSlot(input: unknown, ctx: ValidateSlotContext, withJob: true): { slot: SurfaceSlot; jobs: NewJob[] };
export function validateSlot(input: unknown, ctx: ValidateSlotContext, withJob?: true): SurfaceSlot | { slot: SurfaceSlot; jobs: NewJob[] } {
  if (!isObject(input)) fail('slot must be an object');
  const s = input as Record<string, unknown>;
  const slotId = id(s['id'], 'slot', ID_RE, 64);
  const isContext = slotId === SLOT_CONTEXT;
  const isPrimary = slotId === SLOT_PRIMARY;

  const lines = slotLines(s['lines']);
  const widgets = slotWidgets(s['widgets'], ctx);
  if (lines && widgets) fail('context takes either lines or widgets, not both');
  if (!isContext && (lines || widgets)) fail(`lines and widgets are only for the "${SLOT_CONTEXT}" slot; slot "${slotId}" takes text`);
  if (!isPrimary && s['action'] !== undefined && s['action'] !== null) fail(`action is only for the "${SLOT_PRIMARY}" slot (the button under the time)`);

  const slotText = text(s, 'text', BOUNDS.slotText, { required: !(isContext && (lines || widgets)) });
  if (slotText && (lines || widgets)) fail('give context either text, lines or widgets, not several');
  if (isContext && !slotText && !lines && !widgets) fail('context needs lines (up to 2 short strings) or widgets (up to 3 widget ids)');

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

  let action: SurfaceAction | undefined;
  const jobs: NewJob[] = [];
  if (s['action'] !== undefined && s['action'] !== null) {
    if (!ctx.follow) fail('action cannot be validated here: the surface has no followed conversation');
    const built = validateAction(s['action'], 'action', { follow: ctx.follow!, source: ctx.source, now: ctx.now }, until!);
    action = built.action;
    jobs.push(built.job);
  }

  const slot: SurfaceSlot = {
    id: slotId, ...(slotText ? { text: slotText } : {}), ...(lines ? { lines } : {}), ...(widgets ? { widgets } : {}),
    ...(icon ? { icon } : {}), ...(color ? { color } : {}), ...(action ? { action } : {}),
    until: until!, source: ctx.source, updated_at: new Date(ctx.now).toISOString(),
  };
  return withJob ? { slot, jobs } : slot;
}

function slotLines(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail('lines must be an array of strings');
  const list = raw as unknown[];
  if (list.length < 1) fail('lines is empty; give 1 or 2 lines, or use widgets');
  if (list.length > BOUNDS.contextLines) fail(`lines has ${list.length} entries; the limit is ${BOUNDS.contextLines}`);
  return list.map((l, i) => text({ v: l }, 'v', BOUNDS.contextLineText, { required: true, label: `lines[${i}]` })!);
}

function slotWidgets(raw: unknown, ctx: ValidateSlotContext): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail('widgets must be an array of widget ids');
  const list = raw as unknown[];
  if (list.length < 1) fail('widgets is empty; give 1 to 3 widget ids, or use lines');
  if (list.length > BOUNDS.contextWidgets) fail(`widgets has ${list.length} entries; the limit is ${BOUNDS.contextWidgets}`);
  const seen = new Set<string>();
  return list.map((w, i) => {
    const wid = id(w, `widgets[${i}]`, ID_RE, 64);
    if (seen.has(wid)) fail(`widgets[${i}] "${wid}" is listed twice`);
    seen.add(wid);
    if (ctx.widgetExists && !ctx.widgetExists(wid)) fail(`widgets[${i}] "${wid}" does not exist on this surface; write the widget first (surface_write_widget)`);
    return wid;
  });
}

// ── Faces ────────────────────────────────────────────────────────────────────

/** Validate a face `layout`: `{ slots: { event_ring?: boolean, primary?: boolean, context?: 'lines' | 'widgets' } }`, nothing else. */
export function validateFaceLayout(raw: unknown): FaceLayout {
  if (!isObject(raw)) fail('layout must be an object: { slots: { event_ring?, primary?, context? } }');
  const l = raw as Record<string, unknown>;
  const extra = Object.keys(l).filter((k) => k !== 'slots');
  if (extra.length) fail(`layout has unknown key "${extra[0]}"; the only key is slots`);
  if (!isObject(l['slots'])) fail('layout.slots must be an object: { event_ring?: boolean, primary?: boolean, context?: "lines" | "widgets" }');
  const slots = l['slots'] as Record<string, unknown>;
  const out: FaceLayout['slots'] = {};
  for (const [k, v] of Object.entries(slots)) {
    if (k === 'event_ring' || k === 'primary') {
      if (typeof v !== 'boolean') fail(`layout.slots.${k} must be true or false`);
      out[k] = v as boolean;
    } else if (k === 'context') {
      if (v !== 'lines' && v !== 'widgets') fail('layout.slots.context must be "lines" or "widgets"');
      out.context = v as 'lines' | 'widgets';
    } else {
      fail(`layout.slots has unknown slot "${k}"; known slots are event_ring, primary, context`);
    }
  }
  return { slots: out };
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
