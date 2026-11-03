/**
 * E96 — Surface API v2: the shared contract.
 *
 * A **surface** is a named content stream an agent publishes to (configured under
 * `adapters.intercom.surfaces`, mirrored into the `surfaces` table). A **device** is
 * a consumer paired to one surface with its own credential, profile and scope.
 *
 * Content lives in per-surface **resources**, each with a monotonic `rev`. Every
 * change is a list of {@link ResourceOp}s; devices receive them as `delta` frames
 * (protocol v2) and can fetch the whole picture with `GET /api/v1/surface/state`.
 *
 * Object shapes and bounds here are the bus side of the Compact architecture
 * (peggy-claude-code/data/intercom/architecture.md section 3). That document was
 * not available when this was written; reconcile any differences there first.
 *
 * No I/O in this file: safe for every module to import.
 */

// ── Surfaces and devices ─────────────────────────────────────────────────────

export type DeviceScope = 'interactive' | 'read_only';

/** A `surfaces` row (synced from config at startup). */
export interface SurfaceRow {
  id: string;
  profile: string;
  /** JSON `{contact, channel, topic?}`. */
  follow: { contact: string; channel: string; topic?: string };
  created_at: string;
  updated_at: string;
}

/** A `surface_devices` row as the API exposes it (never the credential or its hash). */
export interface Device {
  id: string;
  surface_id: string;
  name: string;
  /** Display profile hint: `round466`, `rectangular`, `phone`, ... */
  profile: string;
  scope: DeviceScope;
  /** True for the device created from a pre-E96 `token_env` shared token. */
  legacy: boolean;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

/** Answer to `POST /api/v1/surface/pair` (and the alias `/api/v1/intercom/pair`). */
export interface PairResult {
  surface_id: string;
  device_id: string;
  /** The device credential. Shown once; only its sha256 is stored. Also returned as `token` for v1 clients. */
  credential: string;
  token: string;
  scope: DeviceScope;
  profile: string;
  /** SHA-256 fingerprint of the surface listener's certificate (`AA:BB:...`), when the TLS listener is configured. */
  cert_fingerprint: string | null;
}

// ── Resources ────────────────────────────────────────────────────────────────

export const RESOURCE_NAMES = ['faces', 'events', 'slots', 'widgets', 'sessions', 'notices', 'device'] as const;
export type ResourceName = (typeof RESOURCE_NAMES)[number];

/**
 * One change. Every resource is a keyed collection of JSON objects (`id` → item).
 * `set` replaces (or creates) an item, `patch` shallow-merges into an existing one
 * (a `null` value deletes that key), `remove` deletes it. `reset` (server to device
 * only) replaces the whole collection with `items`.
 */
export type ResourceOp =
  | { op: 'set'; id: string; value: Record<string, unknown> }
  | { op: 'patch'; id: string; value: Record<string, unknown> }
  | { op: 'remove'; id: string };

/** Full contents of one resource. */
export interface ResourceSnapshot { rev: number; items: Record<string, Record<string, unknown>> }

/** `GET /api/v1/surface/state` */
export interface SurfaceState {
  surface_id: string;
  device_id: string;
  server_time: string;
  revs: Record<ResourceName, number>;
  resources: Record<ResourceName, ResourceSnapshot['items']>;
}

/**
 * WS v2 server→device frame. `base_rev` is the rev the ops apply on top of;
 * a device whose rev differs must ignore the frame and re-sync (`GET /state`
 * or reconnect with its revs). With `reset: true` the frame carries `items`
 * (the whole collection at `rev`) instead of `ops`.
 */
export type DeltaFrame =
  | { type: 'delta'; resource: ResourceName; base_rev: number; rev: number; ops: ResourceOp[] }
  | { type: 'delta'; resource: ResourceName; rev: number; reset: true; items: ResourceSnapshot['items'] };

/**
 * The per-surface resource store and fan-out (S96.3). Writers call {@link apply};
 * the hub persists, bumps the rev, logs the ops for replay and (after coalescing)
 * hands delta frames to the sink.
 */
export interface ResourceHub {
  /** Apply ops atomically; returns the new rev. Throws {@link BoundsError} on invalid input (nothing is written). */
  apply(surfaceId: string, resource: ResourceName, ops: ResourceOp[]): number;
  get(surfaceId: string, resource: ResourceName, id: string): Record<string, unknown> | null;
  snapshot(surfaceId: string, resource: ResourceName): ResourceSnapshot;
  revs(surfaceId: string): Record<ResourceName, number>;
  /** Frames that bring a device from `revs` to now: per resource, nothing, one coalesced delta, or a reset. */
  resume(surfaceId: string, revs: Partial<Record<ResourceName, number>>): DeltaFrame[];
  /**
   * Remove `events` whose `expires_at` and `slots` whose `until` is at or before `now`
   * (through {@link apply}, so devices get deltas). Returns what was removed so the
   * caller can drop related jobs.
   */
  sweepExpired(now?: number): { surface: string; resource: ResourceName; id: string }[];
  /** Flush pending coalesced deltas immediately (tests, shutdown). */
  flush(): void;
  /** Clear coalescing timers. Pending frames are dropped: call {@link flush} first to send them. */
  stop(): void;
}

/** Thrown by validators and the hub for input outside the bounds below. The message is shown to the agent verbatim. */
export class BoundsError extends Error {
  constructor(message: string) { super(message); this.name = 'BoundsError'; }
}

// ── Object shapes (items inside resources) ──────────────────────────────────

export type Level = 'info' | 'attention' | 'urgent';
export type ActionStyle = 'default' | 'primary' | 'destructive';

/** A button on an Event (or Approval). The device sees this; the job behind it stays on the bus. */
export interface SurfaceAction {
  /** Unique within its object: `[a-z0-9_-]{1,32}`. */
  id: string;
  /** At most {@link BOUNDS.actionLabel} characters. */
  label: string;
  style?: ActionStyle;
  /**
   * Present when tapping sends something on Chris's behalf. The device shows `draft`
   * verbatim and must echo it back in the action request; the bus rejects a mismatch.
   */
  confirm?: { draft: string; prompt?: string };
  /** One-shot (default true): after one successful fire, further taps get `already_done`. */
  once?: boolean;
}

export type EventLayer = 'primary' | 'overlap';
export type EventOpens = 'focus' | 'conversation';
export type TravelMode = 'walk' | 'drive' | 'transit' | 'bike' | 'train';
export interface EventTravel { minutes: number; mode?: TravelMode }
export interface EventDetail {
  description?: string;
  location?: string;
  /** Asset hash (64 hex, sha256) of an uploaded image; fetch it with `GET /assets/:hash`. */
  image?: string;
}

/** `events` item. Agent-created cards on the dial ("I'm here", "Train in 10 min", ...). */
export interface SurfaceEvent {
  id: string;
  kind: 'event' | 'approval';
  title: string;
  body?: string;
  level: Level;
  /**
   * Ring placement (ISO). Only a `kind: 'event'` with BOTH `at` and `end` draws a segment on the
   * Day Dial ring; an event with only `at` is a card, and approvals never draw on the ring.
   */
  at?: string;
  end?: string;
  /** Ring layer for a ring event: the one `primary` segment or a narrower `overlap` one. Absent means `primary`. */
  layer?: EventLayer;
  /** Segment colour: `#rgb`, `#rrggbb` or a name from {@link COLOR_PALETTE}. */
  color?: string;
  /** Travel time before the event; drives the travel wedge and a leave-by complication. */
  travel?: EventTravel;
  /** What the focus view shows when the segment is tapped. */
  detail?: EventDetail;
  /** What a tap opens: the focus view (default) or the Conversation view of `conversation_id`. */
  opens?: EventOpens;
  /** Required when `opens` is `conversation`. */
  conversation_id?: string;
  /** After this (ISO) the event is removed and its actions answer `expired`. */
  expires_at?: string;
  actions: SurfaceAction[];
  /** For `kind: 'approval'`: what is being approved, verbatim (the draft or the command). */
  approval?: { approval_id?: string; tool?: string; detail: string };
  /** Who published it (`agent:<id>` or `bus`). */
  source: string;
  created_at: string;
  updated_at: string;
}

/**
 * `slots` item: a temporary override of a named face slot. id = slot name (`primary`, `context`
 * or any other name a face defines).
 *
 * - `primary`: `text` plus an optional `action` button (a job sits behind it on the bus).
 * - `context`: either `lines` (at most 2) or `widgets` (at most 3 ids of existing widgets).
 * - other names: `text` only.
 */
export interface SurfaceSlot {
  id: string;
  text?: string;
  icon?: string;
  color?: string;
  /** `context` only: up to {@link BOUNDS.contextLines} short lines. */
  lines?: string[];
  /** `context` only: up to {@link BOUNDS.contextWidgets} widget ids; each must exist when the slot is set. */
  widgets?: string[];
  /** `primary` only: one button, same shape as an Event action. Its object is `slots:<slot id>`. */
  action?: SurfaceAction;
  /** The override ends at this time (ISO); the bus removes it then. */
  until: string;
  source: string;
  updated_at: string;
}

/** `widgets` item: data for a widget the client renders. */
export interface SurfaceWidget {
  id: string;
  /** Widget type, `[a-z0-9_.-]{1,40}` (e.g. `weather`, `countdown`). */
  type: string;
  data: Record<string, unknown>;
  source: string;
  updated_at: string;
}

export type SessionState = 'stuck' | 'waiting' | 'working' | 'finished' | 'idle';

/** `sessions` item: one agent session, built from E94's desk classification. */
export interface SurfaceSession {
  id: string;
  title: string;
  /** What the session is about, from `status(subject)`; null when never set. */
  subject: string | null;
  state: SessionState;
  channel: string;
  conversation_id: string | null;
  since: string;
  last_activity_at: string;
  /** True while an `answer_needed` reply is open (until a tap, a reply or an explicit clear). */
  needs_you: boolean;
  /** The open question's message id, when `needs_you`. */
  needs_you_message_id: string | null;
  system: boolean;
}

/** `notices` item: an open E89 notification as the surface sees it (publicNotification shape). */
export type SurfaceNotice = Record<string, unknown> & { id: string };

/** `faces` item: one face the device can show. id = face name (`day`, `status`, `desk`, `conversation`, ...). */
export interface SurfaceFace { id: string; order: number; enabled: boolean; layout?: FaceLayout }

/**
 * Optional slot bindings of a face. Absent: the device's built-in layout for that face applies.
 * `event_ring` draws ring events; `primary` shows the primary slot (default: the next Event);
 * `context` binds the context slot to its `lines` or its `widgets`.
 */
export interface FaceLayout {
  slots: { event_ring?: boolean; primary?: boolean; context?: 'lines' | 'widgets' };
}

/** `device` item: per-device link state. id = device id. */
export interface SurfaceDeviceState {
  id: string;
  name: string;
  profile: string;
  scope: DeviceScope;
  connected: boolean;
  last_seen_at: string | null;
  battery: number | null;
  quiet: boolean;
  /** What the device reports it is showing (`{"type":"view"}` frame), e.g. `conversation:<id>`. */
  view: string | null;
}

// ── Conversations (on demand, not a pushed resource) ────────────────────────

export interface ConversationMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  created_at: string;
  /** Choice buttons offered with this message, if still open. */
  buttons?: { index: number; label: string }[];
  answer_needed?: boolean;
}

/** `GET /api/v1/surface/conversations/{id}?before=<message_id>&limit=N` */
export interface ConversationPage {
  conversation_id: string;
  title: string;
  messages: ConversationMessage[];
  /** Pass as `before` to get older messages; null at the start. */
  next_before: string | null;
}

// ── Actions and jobs ─────────────────────────────────────────────────────────

/**
 * A stored job: the scheduler's item shape with `trigger: 'action'` instead of a
 * time. On fire, `payload_body` is injected into the inbound pipeline exactly as a
 * scheduled item is (sender, channel, topic).
 */
export interface SurfaceJob {
  id: string;
  surface_id: string;
  /** `events:<event id>:<action id>` or `slots:<slot id>:<action id>` — the object and button this job sits behind. */
  object_ref: string;
  trigger: 'action';
  channel: string;
  sender: string;
  topic: string;
  payload_body: string;
  /** True when firing sends on Chris's behalf; requires `confirm_draft`. */
  sends_on_behalf: boolean;
  confirm_draft: string | null;
  once: boolean;
  expires_at: string | null;
  fire_count: number;
  last_fired_at: string | null;
  created_by: string;
  created_at: string;
}

/** `POST /api/v1/surface/actions` body and WS `{"type":"action", ...}` frame. */
export interface ActionRequest {
  /**
   * `events:<id>`, `notices:<id>`, `slots:<slot id>` (the primary slot's button) or
   * `conversations:<conversation id>` (a choice button of a conversation; `action_id` is the button index).
   */
  object: string;
  action_id: string;
  /** Client-generated, unique per tap (a retry of the same tap reuses it). */
  idempotency_key: string;
  /** Required (and must match exactly) when the action has `confirm.draft`. */
  draft?: string;
  /** `conversations:` only: the bus message id the buttons belong to; default is the newest open prompt in the conversation. */
  message_id?: string;
}

export type ActionStatus = 'done' | 'failed' | 'expired' | 'already_done';

/** HTTP response and WS `{"type":"action_result", ...}` frame. */
export interface ActionResult {
  type: 'action_result';
  idempotency_key: string;
  status: ActionStatus;
  /** For `failed`: `not_found`, `confirm_required`, `draft_mismatch`, `read_only`, `rate_limited`, `invalid`, or the pipeline's reason. */
  reason?: string;
  message_id?: string;
}

// ── Bounds ───────────────────────────────────────────────────────────────────

export const BOUNDS = {
  title: 80,
  body: 500,
  actionLabel: 24,
  actionsPerObject: 3,
  draft: 2000,
  /** Live (non-expired) events per surface. */
  eventsPerSurface: 50,
  slotText: 60,
  /** Context slot `lines`: how many, and characters per line. */
  contextLines: 2,
  contextLineText: 40,
  /** Context slot `widgets`. */
  contextWidgets: 3,
  /** Event `detail.description` and `detail.location`. */
  description: 600,
  location: 120,
  /** Event `travel.minutes`. */
  travelMinutes: 720,
  /** Ring layers: at any moment at most this many ring events of the layer may overlap. */
  ringPrimary: 1,
  ringOverlap: 2,
  slotsPerSurface: 12,
  /** Max slot override length. */
  slotMaxHours: 24,
  widgetsPerSurface: 24,
  /** Serialized `data` size per widget, bytes. */
  widgetDataBytes: 4096,
  subject: 60,
  /** Event `expires_at` at most this far ahead. */
  eventMaxDays: 14,
  jobPayload: 4000,
  idemKey: 100,
} as const;

/** Named colours accepted next to `#rgb` / `#rrggbb` on Events. */
export const COLOR_PALETTE = ['orange', 'red', 'green', 'blue', 'purple', 'yellow', 'teal', 'pink', 'gray', 'white'] as const;
export const TRAVEL_MODES: readonly TravelMode[] = ['walk', 'drive', 'transit', 'bike', 'train'];

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const WIDGET_TYPE_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

export const SURFACE_PROTOCOL_VERSION = 2;

// ── Module interfaces (implemented by devices.ts, actions.ts) ───────────────

/** S96.1 — device registry. Implemented by `src/surface/devices.ts`. */
export interface DeviceStore {
  /** Mirror `adapters.intercom.surfaces` into `surfaces`; create or rotate each surface's legacy device from its `token_env`. */
  syncFromConfig(surfaces: { id: string; profile: string; follow: SurfaceRow['follow']; token_env?: string; max_devices?: number }[], env: NodeJS.ProcessEnv): void;
  surface(id: string): SurfaceRow | null;
  /** Resolve a credential to its non-revoked device. Timing-safe; updates nothing. */
  authenticate(credential: string | undefined): Device | null;
  /** Mint a one-time pairing code (stored hashed) for a new device on `surfaceId`. */
  createPairCode(input: { surfaceId: string; name: string; profile?: string; scope?: DeviceScope; ttlMs: number }): { code: string; expires_at: string };
  /**
   * Redeem a v2 code (surface_pair_codes) or a v1 code (intercom_pair_codes): creates the
   * device and returns its credential. Enforces `max_devices`.
   */
  redeem(code: string, certFingerprint: string | null):
    | { ok: true; result: PairResult; device: Device }
    | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'surface_unavailable' | 'device_limit' };
  list(surfaceId?: string, includeRevoked?: boolean): Device[];
  get(deviceId: string): Device | null;
  /** Returns the revoked device, or null when unknown or already revoked. Callers close its sockets. */
  revoke(deviceId: string): Device | null;
  touch(deviceId: string): void;
}

/** A job to store behind one action of an Event (input to {@link JobStore.replaceForEvent}). */
export interface NewJob {
  action_id: string;
  channel: string;
  sender: string;
  topic?: string;
  payload_body: string;
  sends_on_behalf: boolean;
  confirm_draft: string | null;
  once: boolean;
  expires_at: string | null;
}

/** S96.4 — job storage. Implemented by `src/surface/actions.ts`. */
export interface JobStore {
  /** Replace every job behind `events:<eventId>:*` with `jobs` (in one transaction). */
  replaceForEvent(surfaceId: string, eventId: string, jobs: NewJob[], createdBy: string): SurfaceJob[];
  removeForEvent(surfaceId: string, eventId: string): number;
  /** Same for a slot's button: jobs behind `slots:<slotId>:*`. */
  replaceForSlot(surfaceId: string, slotId: string, jobs: NewJob[], createdBy: string): SurfaceJob[];
  removeForSlot(surfaceId: string, slotId: string): number;
  get(surfaceId: string, objectRef: string): SurfaceJob | null;
}

/** S96.4 — the one handler behind `POST /actions` and the WS `action` frame. */
export interface ActionHandler {
  handle(device: Device, request: unknown): Promise<ActionResult>;
}
