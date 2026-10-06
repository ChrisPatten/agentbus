/**
 * Runtime capability taxonomy (E64).
 *
 * Describes what an *agent runtime* can do — the agent side of the bus — as
 * opposed to `AdapterCapabilities` in `./registry.ts`, which describes what a
 * *channel adapter* can do (typing, reactions, tool status, …). The two are
 * deliberately separate types: a channel adapter delivers to a human, a
 * runtime hosts the agent that answers.
 *
 * Capabilities come in two kinds:
 *   - static: fixed by runtime type, declared below and validated at config
 *     load (see `validateRuntimeRequirements` in `./runtime-resolver.ts`);
 *   - live: depend on session state and are checked at run time through
 *     `RuntimeResolver.checkLive()` (pane still leased, transcript still on
 *     disk, harness still polling).
 *
 * Every live capability is also a static one: a runtime that statically lacks
 * it never passes the live check. See docs/RUNTIME_CAPABILITIES.md for the
 * matrix and the evidence behind each value.
 */

/** Agent runtime types the bus knows about. */
export type RuntimeKind = 'cc-headless' | 'cc-pool' | 'claude-code' | 'mcp-polled';

export const RUNTIME_KINDS: readonly RuntimeKind[] = ['cc-headless', 'cc-pool', 'claude-code', 'mcp-polled'];

/** Harness events a runtime can report to the bus through hooks (E66). */
export const HOOK_EVENTS = ['turn-ended', 'pre-compact', 'session-end', 'clear'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface RuntimeCapabilities {
  /**
   * The bus can start a turn with bus-originated content (no human message)
   * scoped to one conversation — a scheduled job, a journaling instruction,
   * an advisory (E65).
   */
  systemMessages: boolean;
  /**
   * Scheduler jobs run as their own background turn: isolated from the
   * human conversation and honoring a per-schedule `model`. Scheduled
   * messages are still *delivered* to runtimes without this; they just land
   * in the shared session like any other message.
   */
  schedules: boolean;
  /** The bus can resume a conversation's prior Claude session by id. Live: transcript still on disk. */
  sessionResume: boolean;
  /** The bus can branch a new conversation from an existing Claude session. Live: transcript still on disk. */
  sessionFork: boolean;
  /** Each conversation gets its own session, never shared. Live (cc-pool): pane still leased to it. */
  exclusiveSession: boolean;
  /**
   * An agent process stays running between turns, holding the session in
   * memory. Live: pane leased to the conversation (cc-pool) or harness
   * currently polling (claude-code, mcp-polled).
   */
  liveAgent: boolean;
  /** The harness loads `CLAUDE.md` and Claude Code auto memory itself (E67). */
  nativeMemory: boolean;
  /** The bus can add context alongside each delivered turn. */
  contextInjection: boolean;
  /** Harness events this runtime can emit through hooks. Empty when none. */
  hookEvents: readonly HookEvent[];
}

/** The boolean capability flags (everything except `hookEvents`). */
export type RuntimeCapability = Exclude<keyof RuntimeCapabilities, 'hookEvents'>;

export const RUNTIME_CAPABILITY_NAMES: readonly RuntimeCapability[] = [
  'systemMessages',
  'schedules',
  'sessionResume',
  'sessionFork',
  'exclusiveSession',
  'liveAgent',
  'nativeMemory',
  'contextInjection',
];

/** Capabilities whose availability also depends on session state (see `RuntimeResolver.checkLive`). */
export const LIVE_CAPABILITIES: ReadonlySet<RuntimeCapability> = new Set<RuntimeCapability>([
  'sessionResume',
  'sessionFork',
  'exclusiveSession',
  'liveAgent',
]);

/**
 * Something a feature can require: a capability flag, or a specific hook
 * event written as `hookEvents:<event>` (e.g. `hookEvents:pre-compact`).
 */
export type RequiredCapability = RuntimeCapability | `hookEvents:${HookEvent}`;

const ALL_HOOK_EVENTS: readonly HookEvent[] = HOOK_EVENTS;

/**
 * Static capability matrix. Each value is checked against the code; the
 * docs page cites where.
 *
 * cc-headless — `claude -p` per batch (src/adapters/cc-headless.ts):
 *   systemMessages: journaling turns and `system:`/scheduled batches spawn a
 *     bus-originated turn. schedules: scheduled batches run in the `system`
 *     turn class with reserved slots and honor `schedule_model`.
 *   sessionResume: `--resume <claude_session_id>`. sessionFork: the app's
 *     Earlier resume (src/app/resume.ts) branches a new bus session from a
 *     resumable transcript; the bus does not pass `--fork-session`.
 *   exclusiveSession: one Claude session per conversation_id.
 *   liveAgent: false — no process between turns.
 *   nativeMemory: true for the harness; the bus currently sets
 *     CLAUDE_CODE_DISABLE_AUTO_MEMORY and injects memory itself until E67.
 *   contextInjection: memory blocks via the context ledger.
 *   hookEvents: only `pre-compact` — the bus sees turn end and process exit
 *     directly, and `/clear` is a bus command, not a harness event.
 *
 * cc-pool — leased interactive panes (src/pool/):
 *   systemMessages/schedules: bus-originated envelopes route to the
 *     conversation's own pane; scheduled jobs get their own `sched:` topic
 *     (own pane) and `schedule_model`. sessionResume: `pickSession` →
 *     `--resume`. sessionFork: false — Earlier resume only resolves
 *     cc-headless instances. exclusiveSession/liveAgent: one leased pane per
 *     conversation. contextInjection: cc.ts renders injected context into
 *     the channel notification. hookEvents: interactive Claude Code — Stop,
 *     PreCompact, SessionEnd and `/clear` all fire.
 *
 * claude-code — one persistent shared session polling via cc.ts:
 *   the bus does not launch or resume it and every conversation shares it,
 *   so no conversation-scoped system turns, no isolated schedules, no
 *   resume/fork, not exclusive. liveAgent: a process polls between turns.
 *
 * mcp-polled — any other harness draining the agent queue over HTTP:
 *   the bus only knows it polls. Nothing else is assumed.
 */
export const RUNTIME_CAPABILITIES: Readonly<Record<RuntimeKind, Readonly<RuntimeCapabilities>>> = Object.freeze({
  'cc-headless': Object.freeze({
    systemMessages: true,
    schedules: true,
    sessionResume: true,
    sessionFork: true,
    exclusiveSession: true,
    liveAgent: false,
    nativeMemory: true,
    contextInjection: true,
    hookEvents: Object.freeze(['pre-compact'] as HookEvent[]),
  }),
  'cc-pool': Object.freeze({
    systemMessages: true,
    schedules: true,
    sessionResume: true,
    sessionFork: false,
    exclusiveSession: true,
    liveAgent: true,
    nativeMemory: true,
    contextInjection: true,
    hookEvents: Object.freeze([...ALL_HOOK_EVENTS]),
  }),
  'claude-code': Object.freeze({
    systemMessages: false,
    schedules: false,
    sessionResume: false,
    sessionFork: false,
    exclusiveSession: false,
    liveAgent: true,
    nativeMemory: true,
    contextInjection: true,
    hookEvents: Object.freeze([...ALL_HOOK_EVENTS]),
  }),
  'mcp-polled': Object.freeze({
    systemMessages: false,
    schedules: false,
    sessionResume: false,
    sessionFork: false,
    exclusiveSession: false,
    liveAgent: true,
    nativeMemory: false,
    contextInjection: false,
    hookEvents: Object.freeze([] as HookEvent[]),
  }),
});

/** Static capabilities for a runtime type. */
export function runtimeCapabilities(kind: RuntimeKind): Readonly<RuntimeCapabilities> {
  return RUNTIME_CAPABILITIES[kind];
}

/** True if `caps` statically provides `required`. */
export function hasCapability(caps: Readonly<RuntimeCapabilities>, required: RequiredCapability): boolean {
  if (required.startsWith('hookEvents:')) {
    return caps.hookEvents.includes(required.slice('hookEvents:'.length) as HookEvent);
  }
  return caps[required as RuntimeCapability] === true;
}

/** The subset of `required` that `caps` does not provide, in the given order. */
export function missingCapabilities(
  caps: Readonly<RuntimeCapabilities>,
  required: readonly RequiredCapability[],
): RequiredCapability[] {
  return required.filter((r) => !hasCapability(caps, r));
}

/** One-line summary for /status, e.g. "systemMessages, schedules; hooks: pre-compact". */
export function formatCapabilities(caps: Readonly<RuntimeCapabilities>): string {
  const flags = RUNTIME_CAPABILITY_NAMES.filter((name) => caps[name]);
  const hooks = caps.hookEvents.length > 0 ? caps.hookEvents.join(', ') : 'none';
  return `${flags.length > 0 ? flags.join(', ') : 'none'}; hooks: ${hooks}`;
}
