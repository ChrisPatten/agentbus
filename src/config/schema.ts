/**
 * Application configuration schema (Zod).
 *
 * The full config is loaded once at startup from a YAML file and an optional
 * .env file, then validated against AppConfigSchema. All pipeline stages and
 * adapters receive the typed AppConfig inferred from this schema.
 *
 * Top-level sections:
 *   bus       — HTTP server and database settings
 *   adapters  — Per-adapter credentials and tuning
 *   contacts  — Known sender → contact mappings
 *   topics    — Recognised topic labels
 *   memory    — Session and transcript retention settings
 *   pipeline  — Inbound message processing rules
 */
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { parseFireAt } from '../scheduler/time.js';

/** Platform identifiers and credentials for a known contact. */
const ContactPlatformsSchema = z.object({
  telegram: z
    .object({
      userId: z.number(),
      username: z.string().optional(),
    })
    .optional(),
  bluebubbles: z
    .object({
      handle: z.string(),
    })
    .optional(),
  email: z
    .object({
      /**
       * The contact's email address(es). Forms the inbound allowlist: only mail
       * from these addresses (case-insensitive) resolves to this contact. A
       * string or a list of strings.
       */
      address: z.union([z.string(), z.array(z.string()).min(1)]),
    })
    .optional(),
  pebble: z
    .object({
      /**
       * Bearer token this contact's Pebble Ring proxy sends as
       * `Authorization: Bearer <token>`. The token doubles as identity: a
       * matching token resolves the inbound message's sender directly to
       * this contact — there is no separate login step and no fallback
       * identity for an unrecognized token (see E25 hard-reject decision).
       */
      token: z.string().min(1),
    })
    .optional(),
  siri: z
    .object({
      /**
       * Bearer token the Peggy iOS app sends on `POST /api/v1/siri/ask` as
       * `Authorization: Bearer <token>` (E42). Same identity model as pebble:
       * the token resolves straight to this contact, unknown tokens are a hard
       * 401. It is a send-as-contact credential, so it must be long and random
       * (≥ 16 chars; `openssl rand -hex 24` is the documented way to mint one).
       */
      token: z.string().min(16),
    })
    .optional(),
  app: z.object({ token: z.string().min(16) }).optional(),
});

/** A named contact that can send messages to the bus. */
const ContactSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  platforms: ContactPlatformsSchema,
});

/**
 * Core bus settings — HTTP port, database location, logging level, and
 * optional API authentication.
 *
 * auth_token: when set, every API request (except GET /api/v1/health) must
 * include a matching `X-Bus-Token` header. Recommended for any deployment
 * where the HTTP port is reachable outside localhost.
 */
const BusConfigSchema = z.object({
  http_port: z.number().int().min(1).max(65535).default(3000),
  /**
   * Interface the HTTP server binds to. Default '127.0.0.1' — loopback only,
   * matching "Not exposed to the public internet" in docs/HTTP_API.md.
   * Set to '0.0.0.0' to accept connections from other hosts on the LAN (e.g.
   * a reverse proxy on a different machine for a webhook channel like
   * Pebble). Widening this also exposes every other HTTP endpoint on the
   * network; set auth_token too if anything beyond localhost can reach it.
   */
  host: z.string().default('127.0.0.1'),
  db_path: z.string(),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** If set, all API requests must include a matching X-Bus-Token header */
  auth_token: z.string().optional(),
});

const TelegramAdapterSchema = z.object({
  token: z.string(),
  poll_timeout: z.number().int().positive().default(30),
  plugin: z.string().optional(),
});

const BlueBubblesAdapterSchema = z.object({
  server_url: z.string().url(),
  webhook_port: z.number().int().min(1).max(65535),
  plugin: z.string().optional(),
});

/**
 * Email adapter — receives mail over IMAP IDLE and sends replies over SMTP.
 * Defaults target iCloud (imap.mail.me.com / smtp.mail.me.com); set host/port to
 * use any provider. iCloud requires an app-specific password, not the Apple ID
 * password. SMTP credentials default to the IMAP ones (same mailbox account).
 */
const EmailAdapterSchema = z.object({
  imap: z.object({
    host: z.string().default('imap.mail.me.com'),
    port: z.number().int().min(1).max(65535).default(993),
    user: z.string(),
    password: z.string(),
    /** Mailbox/folder to watch for new mail. */
    mailbox: z.string().default('INBOX'),
    /** Implicit TLS (true for port 993). Set false only for STARTTLS servers. */
    secure: z.boolean().default(true),
  }),
  smtp: z
    .object({
      host: z.string().default('smtp.mail.me.com'),
      port: z.number().int().min(1).max(65535).default(587),
      /** SMTP auth user; defaults to imap.user. */
      user: z.string().optional(),
      /** SMTP auth password; defaults to imap.password. */
      password: z.string().optional(),
      /** From header for outbound mail; defaults to imap.user. */
      from: z.string().optional(),
      /** Implicit TLS (true for port 465). 587 uses STARTTLS (secure=false). */
      secure: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * When true (default), inbound mail must pass an Authentication-Results
   * (SPF/DKIM/DMARC) check for its From domain, defeating a spoofed From on an
   * allowlisted address. Disable only for trusted relays that don't stamp the
   * header.
   */
  require_auth: z.boolean().default(true),
  plugin: z.string().optional(),
});

const ClaudeCodeAdapterSchema = z.object({
  poll_interval_ms: z.number().int().positive().default(1000),
  sampling_max_tokens: z.number().int().positive().default(8192),
  plugin: z.string().optional(),
});

/** Default journaling instruction (E20; shared by every journaler since E66). */
export const DEFAULT_JOURNALING_PROMPT =
  'Our conversation has paused. Review it and update your memory files ' +
  "(today's daily journal, MEMORY.md, and any relevant topic files) with " +
  'anything durable worth remembering. Do NOT message the user — this is ' +
  'an internal journaling turn, not a reply.';

/**
 * Per-channel idle gap (ms): a number for every channel, or a record of
 * channel → ms with a required `default` key.
 */
const JournalingThresholdSchema = z.union([
  z.number().int().positive(),
  z.object({ default: z.number().int().positive() }).catchall(z.number().int().positive()),
]);

/**
 * Headless Claude Code adapter — spawns `claude -p` per message batch instead
 * of running a persistent MCP session. Compatible with in-process bus-core.
 */
const CcHeadlessAdapterSchema = z.object({
  agent_id: z.string().default('claude'),
  poll_interval_ms: z.number().int().positive().default(1000),
  system_prompt: z.string(),
  claude_bin: z.string().default('claude'),
  /**
   * Model passed as `--model` to `claude -p` (e.g. `sonnet`, `opus`,
   * `claude-sonnet-4-6`). Omit to let the CLI resolve its own default
   * (CLI default, or `working_dir`'s `.claude/settings.json`).
   */
  model: z.string().optional(),
  /** Maximum simultaneous claude -p children for this instance. */
  max_concurrent_turns: z.number().int().positive().default(5),
  /** Capacity reserved from user turns so scheduled and journal turns can start. */
  reserved_system_slots: z.number().int().nonnegative().default(1),
  /**
   * Working directory for the spawned `claude -p` process. Determines which
   * CLAUDE.md hierarchy is auto-loaded into context (project + parents +
   * ~/.claude) and the base for `@path` expansion in the system prompt.
   * Defaults to the bus-core process cwd.
   */
  working_dir: z.string().optional(),
  /**
   * Message delivered to the user when a `claude -p` invocation fails or
   * returns no result and the agent delivered nothing via the reply tool.
   * Prevents the user from getting pure silence on failure.
   */
  error_reply: z
    .string()
    .default('Sorry — I hit an error processing that. Please try again.'),
  /**
   * When true, appends the raw failure detail (exit code / stderr tail /
   * "claude reported error: ...") to `error_reply` before delivering it to
   * the user. Off by default — raw errors can include internal detail
   * (stderr, file paths) not meant for end users.
   */
  error_passthrough: z.boolean().default(false),
  /**
   * E20 — memory file layout. DEPRECATED since E67: use
   * `agents.<agent-id>.memory` (`journal_lookback_days` is `lookback_days`
   * there). Still read as a fallback for fields the agent block leaves
   * unset; the loader warns when it is set. All paths are resolved relative
   * to `working_dir`.
   */
  memory: z
    .object({
      /** Memory directory, relative to working_dir. */
      dir: z.string().default('memory'),
      /** Index file always loaded into every turn (relative to `dir`). */
      index_file: z.string().default('MEMORY.md'),
      /** Subdirectory holding daily journal files `YYYY-MM-DD.md` (relative to `dir`). */
      daily_subdir: z.string().default('daily'),
      /** How many days of daily journal to load (today + previous N-1). 0 → index only. */
      journal_lookback_days: z.number().int().nonnegative().default(3),
    })
    .prefault({}),
  /**
   * E20 — journaling on pause. When a conversation goes idle past the
   * per-channel threshold, the bus fires a silent `--resume` turn telling the
   * agent to update its memory files. Nothing is delivered to the user.
   *
   * E30 — this is also the debounced memory-sweep mechanism: `threshold_ms`
   * is the idle-debounce leg (resets on every inbound message), and
   * `ceiling_ms` is the hard-ceiling leg (fires even while a conversation
   * stays continuously active, so a long uninterrupted chat still flushes
   * periodically instead of deferring indefinitely). See
   * docs/CC_HEADLESS_ADAPTER.md#memory-logging-e30.
   */
  journaling: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * Per-channel idle gap (ms) that marks a conversation "paused" → journal.
       * Two forms (mirrors `memory.session_close_min_messages`):
       *   - number: applies to every channel
       *   - record: per-channel ms with a required `default` key
       *
       * E30 recommends a short debounce (~3-5 min) here — most turns have
       * nothing new worth journaling, so this only needs to catch a real
       * pause in the conversation, not every reply.
       */
      threshold_ms: JournalingThresholdSchema.default({ default: 1_800_000 }),
      /**
       * E30 — hard ceiling (ms) since the last sweep (or session start, if
       * never journaled), applied globally across channels regardless of
       * idle state. Ensures a continuously-active conversation still
       * journals periodically instead of only on pause. Recommended
       * ~20-30 min. Unset disables the ceiling leg entirely (idle-only
       * behavior, the pre-E30 default).
       */
      ceiling_ms: z.number().int().positive().optional(),
      /** Prompt sent on the silent journaling turn. */
      prompt: z.string().default(DEFAULT_JOURNALING_PROMPT),
    })
    .prefault({}),
}).refine((cfg) => cfg.reserved_system_slots < cfg.max_concurrent_turns, {
  path: ['reserved_system_slots'],
  message: 'reserved_system_slots must be less than max_concurrent_turns',
});

/**
 * Interactive Claude Code session pool over tmux (E48) — a fixed or
 * dynamically-growing set of tmux panes, each running its own interactive
 * `claude` session plus a dedicated `cc.ts` MCP process, leased to
 * conversations on demand by an in-bus pool manager. Complements
 * `cc-headless` (spawns `claude -p` per message batch — no interactive
 * session) and `claude-code` (one persistent session shared by everything).
 * See _bmad-output/epics/E48-cc-session-pool-tmux.md.
 */
const CcPoolAdapterSchema = z.object({
  /**
   * Logical agent id for the pool; routes target
   * `recipientId: agent:<agent_id>`. Individual panes get derived ids
   * (`${agent_id}-pool-${n}`) when they are launched — that derivation
   * happens downstream, not in this schema.
   */
  agent_id: z.string(),
  /** tmux session name holding this pool's panes (one tmux window per pane). */
  tmux_session: z.string(),
  /** Number of panes created at startup. */
  panes: z.number().int().positive().default(2),
  /**
   * `fixed` — exactly `panes` panes for the pool's lifetime.
   * `dynamic` — starts at `panes`, grows on demand up to `max_panes`.
   */
  growth: z.enum(['fixed', 'dynamic']).default('fixed'),
  /**
   * Upper bound on pane count when `growth: 'dynamic'`; ignored when
   * `growth: 'fixed'`. Left optional rather than defaulted here because the
   * effective default equals `panes`, and a static zod `.default()` cannot
   * reference a sibling field's parsed value — downstream code must read
   * this as `cfg.max_panes ?? cfg.panes`.
   */
  max_panes: z.number().int().positive().optional(),
  /**
   * Absolute path to the `claude` CLI binary. Unlike `cc-headless`'s
   * `claude_bin`, this has no default and is required: a bare `claude`
   * typed into a tmux-launched pane resolves through the operator's
   * interactive shell profile, which commonly defines `claude` as a
   * tmux-wrapping shell function/alias rather than the CLI binary itself —
   * see E48 "Prior Art" gotcha 1.
   */
  claude_bin: z.string().refine(isAbsolute, {
    message:
      'claude_bin must be an absolute path (starting with "/") — a bare ' +
      "\"claude\" resolves to the user's shell function/alias rather than " +
      'the CLI binary in a tmux-launched pane, so an absolute path is required',
  }),
  /**
   * Model passed as `--model` to each pane's `claude` invocation. Omit to
   * let the CLI resolve its own default.
   */
  model: z.string().optional(),
  /**
   * Working directory shared by every pane in the pool. Determines which
   * CLAUDE.md hierarchy is auto-loaded into context. Defaults to the
   * bus-core process cwd downstream, same as `cc-headless`.
   */
  working_dir: z.string().optional(),
  /** Extra CLI args appended verbatim to every launch/resume invocation. */
  launch_args: z.array(z.string()).default([]),
  /** Poll interval (ms) passed through to each pane's `cc.ts` MCP process. */
  poll_interval_ms: z.number().int().positive().default(1000),
  /**
   * Unlike `cc-headless` (where `system_prompt` is required and replaces
   * the default prompt), this is optional: interactive pool sessions rely
   * on native CLAUDE.md auto-loading from `working_dir` by default. When
   * given, it is appended via `--append-system-prompt-file` rather than
   * replacing the default.
   */
  system_prompt: z.string().optional(),
  /** Pane lease lifecycle timing. */
  lease: z
    .object({
      /** Idle time (ms) after which a leased pane becomes evictable. */
      idle_evict_ms: z.number().int().positive().default(1_800_000),
      /**
       * Hard ceiling (ms) since a lease started after which it is
       * proactively released regardless of activity.
       */
      hard_idle_ms: z.number().int().positive().default(21_600_000),
      /** How long (ms) a parked message waits for a free pane before erroring back. */
      park_timeout_ms: z.number().int().positive().default(300_000),
    })
    .prefault({}),
  /** What happens to a pane on lease release: clear its screen/context, or kill and relaunch it. */
  on_evict: z.enum(['clear', 'kill']).default('clear'),
  /**
   * Total time (ms) `ackHandshake` polls capture-pane output for the
   * "loading development channels" launch confirmation prompt to actually
   * appear before concluding there is nothing to dismiss. NOT a blind delay
   * before pressing Enter — Enter is only ever sent once the prompt is
   * confirmed showing (see `src/pool/pane.ts`'s `ackHandshake`/
   * `waitForAckPrompt`). Bumped from the original 500ms: measured against
   * the real CLI (v2.1.274-276) across several runs, the prompt first
   * renders roughly 1.0-1.6s after the launch line is sent, so 500ms was
   * consistently too short to ever observe it — see docs/CC_POOL_ADAPTER.md's
   * Troubleshooting section for the resulting bug and fix.
   */
  launch_ack_delay_ms: z.number().int().nonnegative().default(5000),
  /** Max Enter presses to dismiss the ack prompt once it's confirmed showing, before giving up. */
  launch_ack_max_attempts: z.number().int().positive().default(3),
  /**
   * Text matched (case-insensitively) in capture-pane output to detect the
   * `--dangerously-load-development-channels` confirmation prompt; override
   * if the CLI rewords it. Verified against a real captured prompt (v2.1.274):
   * the dialog's header reads "WARNING: Loading development channels" — the
   * default matches that verbatim, rather than the flag name or a generic
   * word like "experimental" (which never appears anywhere in the real
   * prompt and never matched, so the pane was never actually confirmed —
   * see docs/CC_POOL_ADAPTER.md's Troubleshooting section).
   */
  launch_ack_pattern: z.string().default('loading development channels'),
  /**
   * Extra env vars set on the tmux window at creation time
   * (`tmux new-window -e`). `TERM`/`COLORTERM` are added unconditionally by
   * later launch code, not defaulted here.
   */
  pane_env: z.record(z.string(), z.string()).default({}),
  /**
   * Stall watchdog (E52). Deliberately no `.default()`: a zod default would
   * make this a required key on `CcPoolInstanceConfig`. Defaults are applied
   * by `resolveWatchdogConfig()` in src/pool/watchdog-config.ts.
   */
  watchdog: z
    .object({
      enabled: z.boolean().optional(),
      observe_only: z.boolean().optional(),
      sample_interval_ms: z.number().int().positive().optional(),
      stall_after_ms: z.number().int().positive().optional(),
      alert_contact: z.string().optional(),
    })
    .optional(),
});

/**
 * Shared config fragment for logging raw incoming webhook requests to disk —
 * a debugging/audit aid, off by default, since request bodies may contain
 * sensitive content. Reusable by any webhook route (see logWebhookRequest in
 * src/http/webhook-log.ts), not pebble-specific — a future webhook adapter
 * can embed this same schema in its own config block.
 */
const WebhookLoggingConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Base directory; each webhook gets its own `<dir>/<webhook>/<YYYY-MM-DD>.jsonl` file. */
    dir: z.string().default('logs/webhooks'),
  })
  .prefault({});

export type WebhookLoggingConfig = z.infer<typeof WebhookLoggingConfigSchema>;

/**
 * Pebble Ring webhook channel — receive-only HTTP ingress (no host/port/
 * instance fields; there is nothing to poll or connect to). A pure toggle.
 */
const PebbleAdapterSchema = z.object({
  enabled: z.boolean().default(true),
  /** Multipart body-size guard for POST /api/v1/webhooks/pebble. Voice transcripts are short text. */
  max_body_bytes: z.number().int().positive().default(65536),
  /** Log raw incoming webhook requests to disk for debugging/audit (E38). */
  logging: WebhookLoggingConfigSchema,
});

/**
 * Optional re-delivery of a late Siri reply on another channel (E43). Rendered
 * with the shared `{{var}}` renderer; `{{body}}` is Peggy's reply and
 * `{{question}}` the original ask. Accepted by the schema today so the config
 * shape is stable; the adapter acts on it from E43.
 */
const SiriFallbackSchema = z.object({
  channel: z.string().min(1),
  template: z.string().default('Re your Siri question "{{question}}":\n{{body}}'),
});

/**
 * Siri channel adapter (E42 spike, E43 production) — a bidirectional HTTP
 * channel for the Peggy iOS app: `POST /api/v1/siri/ask` submits a question
 * through the normal pipeline and holds the connection open until the agent's
 * reply is delivered to `SiriAdapter.send()`, or `reply_timeout_ms` elapses.
 * Identity comes from `contacts.*.platforms.siri.token` (E25 pattern). See
 * docs/SIRI_ADAPTER.md.
 */
export const SiriAdapterSchema = z.object({
  enabled: z.boolean().default(true),
  /** Server-side cap on how long an ask (or a late-reply poll) may wait. Siri gives an intent ~30 s. */
  reply_timeout_ms: z.number().int().min(1000).max(60000).default(25000),
  /** E43 — retention of durable request/reply records. Accepted, not yet acted on. */
  late_reply_ttl_ms: z.number().int().positive().default(86_400_000),
  /** JSON body-size guard for the ask endpoint. Questions are short text. */
  max_body_bytes: z.number().int().positive().default(8192),
  /** E43 — per-token rate limits. Accepted, not yet enforced. */
  rate_limit: z
    .object({
      per_minute: z.number().int().positive().default(20),
      max_in_flight: z.number().int().positive().default(4),
    })
    .prefault({}),
  /** E43 — late-reply re-delivery. Accepted, not yet acted on. */
  fallback: SiriFallbackSchema.optional(),
  /**
   * E44 only — artificial delay (ms) before `POST /ask` responds, used to find
   * Siri's real wait cutoff on device. The adapter refuses to start when this
   * is > 0 and NODE_ENV=production.
   */
  debug_delay_ms: z.number().int().nonnegative().default(0),
});

export type SiriAdapterConfig = z.infer<typeof SiriAdapterSchema>;

export const AppAdapterSchema = z.object({
  enabled: z.boolean().default(true),
  event_retention_days: z.number().int().positive().default(30),
  max_upload_bytes: z.number().int().positive().default(25 * 1024 * 1024),
  ping_interval_ms: z.number().int().min(1000).default(30_000),
});
export type AppAdapterConfig = z.infer<typeof AppAdapterSchema>;

const AdaptersConfigSchema = z.object({
  telegram: z.union([TelegramAdapterSchema, z.record(z.string(), TelegramAdapterSchema)]).optional(),
  email: z.union([EmailAdapterSchema, z.record(z.string(), EmailAdapterSchema)]).optional(),
  bluebubbles: BlueBubblesAdapterSchema.optional(),
  'claude-code': ClaudeCodeAdapterSchema.optional(),
  'cc-headless': z.union([CcHeadlessAdapterSchema, z.record(z.string(), CcHeadlessAdapterSchema)]).optional(),
  'cc-pool': z.union([CcPoolAdapterSchema, z.record(z.string(), CcPoolAdapterSchema)]).optional(),
  pebble: PebbleAdapterSchema.optional(),
  siri: SiriAdapterSchema.optional(),
  app: AppAdapterSchema.optional(),
});

const MemoryConfigSchema = z.object({
  summarizer_interval_ms: z.number().int().positive().default(60000),
  session_idle_threshold_ms: z.number().int().positive().default(1800000),
  context_window_hours: z.number().positive().default(48),
  /**
   * @deprecated E66 — the Anthropic-API summarizer was retired. Accepted and
   * ignored (the loader logs a deprecation warning) so old configs still start.
   */
  claude_api_model: z.string().optional(),
  /** @deprecated E66 — see `claude_api_model`. Accepted and ignored. */
  summary_max_tokens: z.number().int().positive().optional(),
  /**
   * Shell command(s) to run when a session is closed due to inactivity.
   * Executed via /bin/sh -c, so shell syntax is supported.
   *
   * Two forms:
   *   - string: runs for every channel
   *   - record: runs the command for the matching channel only; channels not
   *     listed are silently skipped
   *
   * Env vars available to the command:
   *   AGENTBUS_SESSION_ID    — full session UUID
   *   AGENTBUS_CHANNEL       — e.g. "claude-code", "telegram"
   *   AGENTBUS_CONTACT_ID    — contact identifier
   *   AGENTBUS_MESSAGE_COUNT — number of messages in the session
   *
   * Examples:
   *   # Global (all channels):
   *   on_session_close: "tmux send-keys -t my-pane '/clear' Enter"
   *
   *   # Per-channel:
   *   on_session_close:
   *     claude-code: "tmux send-keys -t pane-cc '/clear' Enter"
   *     telegram:    "tmux send-keys -t pane-tg '/clear' Enter"
   */
  on_session_close: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  /**
   * Minimum number of messages a session must have before it is eligible for
   * idle-expiration. Sessions below this threshold are left open even after
   * `session_idle_threshold_ms` has elapsed.
   *
   * Accepts the same two forms as `on_session_close`:
   *   - number: applies to all channels (default: 0 — no guard)
   *   - record: per-channel threshold; channels not listed default to 0
   *
   * Examples:
   *   session_close_min_messages: 1          # global: require at least 1 message
   *   session_close_min_messages:
   *     claude-code: 1
   *     telegram: 3
   */
  session_close_min_messages: z
    .union([z.number().int().min(0), z.record(z.string(), z.number().int().min(0))])
    .default(0),
  /**
   * Channels for which memory injection (Stage 85) is disabled.
   * Useful for agents that manage their own memory (e.g. pokeclaude).
   *
   * Example:
   *   memory_inject_exclude:
   *     - telegram:pokeclaude
   */
  memory_inject_exclude: z.array(z.string()).default([]),
  /**
   * @deprecated E66 — the summarizer that wrote the `memories` and
   * `session_summaries` tables was retired; the tables are read-only. Accepted
   * and ignored (the loader logs a deprecation warning).
   */
  structured_extraction: z.boolean().optional(),
});

/**
 * Per-agent media handling settings. Controls where inbound images are saved
 * on disk and how long files are retained before the TTL sweeper deletes them.
 *
 *   download_path — directory where attachments for this agent are written;
 *                   created at startup if it does not exist
 *   ttl_seconds   — retention window; defaults to 1 hour
 */
const AgentMediaSchema = z.object({
  download_path: z.string().min(1).refine(isAbsolute, {
    message: 'download_path must be an absolute path',
  }),
  ttl_seconds: z.number().int().positive().default(3600),
});

/**
 * An owner contact (E65): a person who receives bus advisories about this
 * agent, on one channel. `contact_id` is a bare key of `contacts`; `channel`
 * is the exact channel their conversation arrives on (e.g. "telegram",
 * "telegram:peggy", "app"). Owners are used for advisories (and E68
 * proposals) only — they are not a trust tier.
 */
const AgentOwnerSchema = z.object({
  channel: z.string().min(1),
  contact_id: z.string().min(1).refine((id) => !id.startsWith('contact:'), {
    message: 'contact_id must be a bare contact key (drop the "contact:" prefix)',
  }),
});

/** Journalers that can carry out a journal run (E66). See docs/JOURNALING.md. */
export const JOURNALER_IDS = ['system-message', 'cc-headless', 'script'] as const;
export type JournalerId = (typeof JOURNALER_IDS)[number];

/**
 * Per-agent journaling (E66 S66.1): when the bus journals this agent's
 * conversations (triggers) and who does it (the journaler chain). Replaces
 * the `adapters.cc-headless.journaling` block, which still works as a
 * deprecated alias for agents without this block.
 */
const AgentJournalingSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Journalers to try, in order. The bus moves to the next one when a
   * journaler can't run or fails. Entries the agent's runtime can never
   * support are skipped. Default: every journaler, in the order below, with
   * `script` only when `script.command` is set.
   */
  chain: z.array(z.enum(JOURNALER_IDS)).min(1).optional(),
  /** Pause trigger: idle gap before a conversation is evaluated. Default 30 min. */
  threshold_ms: JournalingThresholdSchema.default({ default: 1_800_000 }),
  /** Ceiling trigger: max time since the last journal (or session start). Unset → no ceiling. */
  ceiling_ms: z.number().int().positive().optional(),
  /** New human messages needed before a non-final trigger journals. */
  min_human_messages: z.number().int().positive().default(2),
  /** Per-run timeout for journalers that wait on the agent. */
  timeout_ms: z.number().int().positive().default(300_000),
  /** Model for journal runs. Default: the agent's runtime model. */
  model: z.string().min(1).optional(),
  /** Journaling instruction. Default: the built-in prompt. */
  prompt: z.string().min(1).optional(),
  'system-message': z
    .object({
      timeout_ms: z.number().int().positive().optional(),
      model: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
    })
    .optional(),
  'cc-headless': z
    .object({
      model: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
    })
    .optional(),
  script: z
    .object({
      /** Executable run directly (no shell). Absolute, or resolved against the agent's working_dir. */
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      timeout_ms: z.number().int().positive().optional(),
      env: z.record(z.string(), z.string()).default({}),
      model: z.string().min(1).optional(),
    })
    .optional(),
}).superRefine((j, ctx) => {
  const chain = j.chain ?? [];
  const seen = new Set<string>();
  chain.forEach((id, i) => {
    if (seen.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate journaler "${id}" in chain`, path: ['chain', i] });
    }
    seen.add(id);
  });
  if (chain.includes('script') && !j.script) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'chain includes "script" but journaling.script.command is not set',
      path: ['script'],
    });
  }
});

export type AgentJournalingConfig = z.infer<typeof AgentJournalingSchema>;

/**
 * Per-agent memory layout (E67 S67.1): where the agent's memory files live
 * and how the bus builds `recent.md` from the daily journals. Shared by
 * journaling (the memory dir handed to journalers) and loading (native auto
 * memory's `autoMemoryDirectory`, or bus injection on runtimes without
 * native memory). Every field is optional; unset fields fall back to the
 * deprecated `adapters.cc-headless.memory` block, then to the defaults.
 * See docs/AGENT_MEMORY.md.
 */
const AgentMemorySchema = z.object({
  /** Memory directory: relative to the agent's working_dir, or absolute. Default `memory`. */
  dir: z.string().min(1).optional(),
  /** Index file inside `dir`. Default `MEMORY.md`. */
  index_file: z.string().min(1).optional(),
  /** Subdirectory of `dir` with the daily journals `YYYY-MM-DD.md`. Default `daily`. */
  daily_subdir: z.string().min(1).optional(),
  /** Days of daily journals in `recent.md` (today and the previous N-1, local dates). Default 3; 0 = none. */
  lookback_days: z.number().int().nonnegative().optional(),
  /** Character budget for the whole `recent.md`. Default 20000. */
  recent_budget_chars: z.number().int().min(500).optional(),
  /**
   * Load memory natively (Claude Code auto memory pointed at `dir`) on
   * runtimes that support it. Default true. false keeps bus injection of
   * the index and `recent.md` (cc-headless only).
   */
  native: z.boolean().optional(),
});

export type AgentMemoryConfig = z.infer<typeof AgentMemorySchema>;

/**
 * Per-agent configuration, keyed by recipient id (e.g. "agent:claude").
 * Additional agent-scoped settings live here under the same key: E65 adds
 * `owners`; E66 adds `journaling`, E67 `memory`.
 */
const AgentConfigSchema = z.object({
  media: AgentMediaSchema.optional(),
  owners: z.array(AgentOwnerSchema).optional(),
  journaling: AgentJournalingSchema.optional(),
  memory: AgentMemorySchema.optional(),
});

/**
 * A topic-classification rule. Rules are evaluated in order; the first match
 * wins. A rule can match by keyword list, regex pattern, or both (keyword
 * checked first). Patterns are compiled once at factory construction time to
 * avoid per-message RegExp allocation and ReDoS risk.
 */
const TopicRuleSchema = z.object({
  topic: z.string(),
  keywords: z.array(z.string()).optional(),
  pattern: z.string().optional(),
});

/**
 * Numeric weights used by Stage 60 (priority-score) to compute a 0–100
 * priority score. Scores ≥ 70 → urgent; ≥ 40 → high; < 40 → normal.
 */
const PriorityWeightsSchema = z.object({
  base_score: z.number().default(0),
  /** Bonus applied when the message topic is any non-'general' value */
  topic_bonus: z.number().default(40),
  vip_sender_bonus: z.number().default(20),
  urgency_keyword_bonus: z.number().default(15),
});

/** A single delivery destination: which adapter to use and which recipient ID to address. */
const RouteTargetSchema = z.object({
  adapterId: z.string(),
  recipientId: z.string(),
});

/**
 * A routing rule. match fields are AND-ed; omitted fields match anything.
 * An empty match ({}) is a catch-all — if it appears before the last rule,
 * route-resolve emits a construction-time warning.
 * also_notify fans the message out to additional targets alongside target.
 */
const RouteRuleSchema = z.object({
  match: z.object({
    sender: z.string().optional(),
    channel: z.string().optional(),
    topic: z.string().optional(),
  }),
  target: RouteTargetSchema,
  also_notify: z.array(RouteTargetSchema).optional(),
});

/**
 * A relay target: a different channel a message should be re-arrived on,
 * plus a template rendered over its body. `{{body}}`, `{{sender}}`, and
 * `{{channel}}` (the *source* channel) placeholders are substituted by the
 * `channel-relay` stage (Stage 25) using the same `{{variable}}` renderer
 * `prompt-renderer.ts` uses for cc-headless system prompts.
 */
const RelayTargetSchema = z.object({
  channel: z.string(),
  template: z.string().default('{{body}}'),
});

/**
 * A relay rule (E26). Unlike a route rule — which picks a delivery target for
 * an already-arrived message — a relay rule re-submits the message as a
 * brand-new inbound arrival on a different channel, with its body rewritten.
 * match fields are AND-ed the same way RouteRuleSchema.match is; an empty
 * match ({}) is a catch-all — if it appears before the last rule,
 * channel-relay emits a construction-time warning.
 */
const RelayRuleSchema = z.object({
  match: z.object({
    sender: z.string().optional(),
    channel: z.string().optional(),
    topic: z.string().optional(),
  }),
  target: RelayTargetSchema,
});

/**
 * Controls every aspect of inbound message processing: deduplication window,
 * unrouted-message behaviour, topic classification rules, priority scoring
 * weights, and routing/relay rules. All fields have sensible defaults so an
 * empty pipeline: {} block is valid.
 */
const PipelineConfigSchema = z.object({
  stages: z.array(z.string()).optional(),
  dedup_window_ms: z.number().int().positive().default(30000),
  drop_unrouted: z.boolean().default(false),
  topic_rules: z.array(TopicRuleSchema).default([]),
  priority_weights: PriorityWeightsSchema.default({ base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 }),
  urgency_keywords: z.array(z.string()).default(['urgent', 'asap', 'emergency', 'critical']),
  vip_contacts: z.array(z.string()).default([]),
  routes: z.array(RouteRuleSchema).default([]),
  relays: z.array(RelayRuleSchema).default([]),
});

/**
 * A static schedule entry defined in config.yaml.
 * Either `cron` or `fire_at` must be provided (not both).
 */
const ScheduleEntrySchema = z
  .object({
    id: z.string().min(1),
    cron: z.string().optional(),
    fire_at: z.string().optional(),
    timezone: z.string().default('UTC'),
    channel: z.string(),
    sender: z.string(),
    prompt: z.string(),
    label: z.string().optional(),
    // No default here (E53 D1) — undefined means "the scheduler decides",
    // which for a cron entry is sched:<label-slug>; see default-topic.ts.
    topic: z.string().min(1).optional(),
    priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
    max_fires: z.number().int().positive().optional(),
    /** Model this job's pane should launch with, e.g. "haiku" (E53). Unset = pool/override default. */
    model: z.string().min(1).max(100).optional(),
  })
  .refine((d) => !!(d.cron ?? d.fire_at), {
    message: 'Each schedule entry must specify either cron or fire_at',
  })
  .refine(
    (d) => {
      if (!d.fire_at) return true;
      try {
        parseFireAt(d.fire_at, d.timezone);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'fire_at must be a valid ISO 8601 timestamp, and timezone a valid IANA time zone' },
  );

const SchedulerConfigSchema = z.object({
  tick_interval_ms: z.number().int().positive().default(30000),
  enabled: z.boolean().default(true),
});

/**
 * Root application config schema. Validated at startup; an error here is
 * fatal. All stage factories, adapters, and the HTTP server receive the
 * resulting AppConfig object.
 *
 * contacts validation: enforces that each contact's `id` field matches its
 * map key so lookups and cross-references are unambiguous.
 */
export const AppConfigSchema = z.object({
  bus: BusConfigSchema,
  adapters: AdaptersConfigSchema,
  contacts: z.record(z.string(), ContactSchema).default({}).superRefine((contacts, ctx) => {
    for (const [key, contact] of Object.entries(contacts)) {
      if (contact.id !== key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Contact id "${contact.id}" must match its record key "${key}"`,
          path: [key, 'id'],
        });
      }
    }

    // Pebble and Siri bearer tokens double as sender identity — a token shared
    // by two contacts would make sender resolution ambiguous, so duplicates are
    // rejected per platform.
    for (const platform of ['pebble', 'siri', 'app'] as const) {
      const byToken = new Map<string, string>();
      for (const [key, contact] of Object.entries(contacts)) {
        const token = contact.platforms[platform]?.token;
        if (!token) continue;
        const owner = byToken.get(token);
        if (owner) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate ${platform} token — also used by contact "${owner}"`,
            path: [key, 'platforms', platform, 'token'],
          });
        } else {
          byToken.set(token, key);
        }
      }
    }
  }),
  topics: z.array(z.string()).default(['general']),
  agents: z.record(z.string(), AgentConfigSchema).default({}),
  memory: MemoryConfigSchema,
  scheduler: SchedulerConfigSchema.default({ tick_interval_ms: 30000, enabled: true }),
  schedules: z.array(ScheduleEntrySchema).default([]).superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const { id } = entries[i]!;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate schedule id "${id}" — each schedule must have a unique id`,
          path: [i, 'id'],
        });
      }
      seen.add(id);
    }
  }),
  pipeline: PipelineConfigSchema.default({
    dedup_window_ms: 30000,
    drop_unrouted: false,
    topic_rules: [],
    priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
    urgency_keywords: ['urgent', 'asap', 'emergency', 'critical'],
    vip_contacts: [],
    routes: [],
    relays: [],
  }),
}).superRefine((cfg, ctx) => {
  // E65 — owner contacts must name a configured contact, once per channel.
  for (const [agentKey, agent] of Object.entries(cfg.agents)) {
    const seen = new Set<string>();
    (agent.owners ?? []).forEach((owner, i) => {
      if (!cfg.contacts[owner.contact_id]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Owner contact "${owner.contact_id}" is not defined under contacts`,
          path: ['agents', agentKey, 'owners', i, 'contact_id'],
        });
      }
      const key = `${owner.contact_id}\u0000${owner.channel}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate owner ${owner.contact_id} on ${owner.channel}`,
          path: ['agents', agentKey, 'owners', i],
        });
      }
      seen.add(key);
    });
  }
});

/** Fully-typed application configuration */
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** Normalised config for a single Telegram bot instance. */
export interface TelegramInstanceConfig {
  /** Bot name used as the adapter id suffix, or null for the legacy single-bot form. */
  name: string | null;
  token: string;
  poll_timeout: number;
  plugin?: string;
}

/**
 * Normalises `config.adapters.telegram` into a flat list of instances.
 *
 * Accepts both forms:
 *   - Legacy single-bot: `{ token, poll_timeout?, plugin? }` → one instance with name=null
 *   - Named record: `{ peggy: { token, ... }, jarvis: { token, ... } }` → one instance per key
 *
 * Throws if any tokens are duplicated across instances.
 */
export function getTelegramInstances(config: AppConfig): TelegramInstanceConfig[] {
  const telegram = config.adapters.telegram;
  if (!telegram) return [];

  // Discriminate: single-bot form has 'token' as a string at the top level.
  if (typeof (telegram as { token?: unknown }).token === 'string') {
    const t = telegram as { token: string; poll_timeout: number; plugin?: string };
    return [{ name: null, token: t.token, poll_timeout: t.poll_timeout, plugin: t.plugin }];
  }

  // Named-record form.
  const record = telegram as Record<string, { token: string; poll_timeout: number; plugin?: string }>;
  const seen = new Set<string>();
  const instances: TelegramInstanceConfig[] = [];

  const VALID_INSTANCE_NAME_RE = /^[a-z0-9_-]+$/;

  for (const [name, cfg] of Object.entries(record)) {
    if (!VALID_INSTANCE_NAME_RE.test(name)) {
      throw new Error(
        `Invalid Telegram instance name "${name}" — only lowercase letters, digits, hyphens, and underscores are allowed`,
      );
    }
    if (seen.has(cfg.token)) {
      throw new Error(
        `Duplicate Telegram bot token for instance "${name}" — each bot must have a unique token`,
      );
    }
    seen.add(cfg.token);
    instances.push({ name, token: cfg.token, poll_timeout: cfg.poll_timeout, plugin: cfg.plugin });
  }

  return instances;
}

/** Validated config for a single email adapter (one mailbox). */
export type EmailAdapterConfig = z.infer<typeof EmailAdapterSchema>;

/** Normalised config for a single email account instance. */
export interface EmailInstanceConfig extends EmailAdapterConfig {
  /** Account name used as the adapter id suffix, or null for the single-account form. */
  name: string | null;
}

/**
 * Normalises `config.adapters.email` into a flat list of instances.
 *
 * Accepts both forms, mirroring getTelegramInstances():
 *   - Single account: `{ imap, smtp, ... }` → one instance with name=null (id "email")
 *   - Named record: `{ peggy: { imap, ... }, work: { imap, ... } }` → one per key
 *     (ids "email:peggy", "email:work")
 *
 * Throws on an invalid instance name or a duplicate IMAP account across instances.
 */
export function getEmailInstances(config: AppConfig): EmailInstanceConfig[] {
  const email = config.adapters.email;
  if (!email) return [];

  // Discriminate: the single-account form has the `imap` block at the top level.
  if ('imap' in email && typeof (email as { imap?: unknown }).imap === 'object') {
    return [{ name: null, ...(email as EmailAdapterConfig) }];
  }

  const record = email as Record<string, EmailAdapterConfig>;
  const seen = new Set<string>();
  const instances: EmailInstanceConfig[] = [];

  const VALID_INSTANCE_NAME_RE = /^[a-z0-9_-]+$/;

  for (const [name, cfg] of Object.entries(record)) {
    if (!VALID_INSTANCE_NAME_RE.test(name)) {
      throw new Error(
        `Invalid email instance name "${name}" — only lowercase letters, digits, hyphens, and underscores are allowed`,
      );
    }
    const accountKey = `${cfg.imap.host}:${cfg.imap.user.toLowerCase()}`;
    if (seen.has(accountKey)) {
      throw new Error(
        `Duplicate email account "${cfg.imap.user}" on "${cfg.imap.host}" for instance "${name}" — each mailbox must be unique`,
      );
    }
    seen.add(accountKey);
    instances.push({ name, ...cfg });
  }

  return instances;
}

/** Resolved config for a single headless Claude Code adapter instance. */
export type CcHeadlessAdapterConfig = z.infer<typeof CcHeadlessAdapterSchema>;

/** Normalised config for a single `cc-headless` agent instance. */
export interface CcHeadlessInstanceConfig extends CcHeadlessAdapterConfig {
  /** Instance name used as the adapter id suffix, or null for the legacy single-instance form. */
  name: string | null;
}

/**
 * Normalises `config.adapters['cc-headless']` into a flat list of instances.
 *
 * Accepts both forms, mirroring getTelegramInstances()/getEmailInstances():
 *   - Legacy single-instance: `{ agent_id, system_prompt, ... }` → one instance with name=null
 *   - Named record: `{ peggy: { agent_id, ... }, pokeclaude: { agent_id, ... } }` → one per key
 *
 * Throws on an invalid instance name or a duplicate `agent_id` across instances
 * — `agent_id` is the key both the poll fetch and journaling routing scope on,
 * so it must be unique.
 */
export function getCcHeadlessInstances(config: AppConfig): CcHeadlessInstanceConfig[] {
  const headless = config.adapters['cc-headless'];
  if (!headless) return [];

  // Discriminate: the single-instance form has `system_prompt` (required) at the top level.
  if (typeof (headless as { system_prompt?: unknown }).system_prompt === 'string') {
    return [{ name: null, ...(headless as CcHeadlessAdapterConfig) }];
  }

  const record = headless as Record<string, CcHeadlessAdapterConfig>;
  const seen = new Set<string>();
  const instances: CcHeadlessInstanceConfig[] = [];

  const VALID_INSTANCE_NAME_RE = /^[a-z0-9_-]+$/;

  for (const [name, cfg] of Object.entries(record)) {
    if (!VALID_INSTANCE_NAME_RE.test(name)) {
      throw new Error(
        `Invalid cc-headless instance name "${name}" — only lowercase letters, digits, hyphens, and underscores are allowed`,
      );
    }
    if (seen.has(cfg.agent_id)) {
      throw new Error(
        `Duplicate cc-headless agent_id "${cfg.agent_id}" for instance "${name}" — each headless agent must have a unique agent_id`,
      );
    }
    seen.add(cfg.agent_id);
    instances.push({ name, ...cfg });
  }

  return instances;
}

/** Resolved config for a single `cc-pool` adapter instance. */
export type CcPoolAdapterConfig = z.infer<typeof CcPoolAdapterSchema>;

/** Normalised config for a single `cc-pool` instance. */
export interface CcPoolInstanceConfig extends CcPoolAdapterConfig {
  /** Instance name used as the adapter id suffix, or null for the single-instance form. */
  name: string | null;
}

/**
 * Normalises `config.adapters['cc-pool']` into a flat list of instances.
 *
 * Accepts both forms, mirroring getCcHeadlessInstances():
 *   - Single-instance: `{ agent_id, tmux_session, ... }` → one instance with name=null
 *   - Named record: `{ 'peggy-pool': { agent_id, ... }, ... }` → one per key
 *
 * Throws on an invalid instance name, a duplicate `agent_id` across instances
 * (the pool's routing target must be unique), a duplicate `tmux_session`
 * across instances (two pools cannot share one tmux session), or on
 * `growth: 'fixed'` combined with an explicit `max_panes` below `panes`
 * (fixed pools ignore `max_panes`, so a value below `panes` can only be an
 * operator mistake worth catching at load time).
 */
export function getCcPoolInstances(config: AppConfig): CcPoolInstanceConfig[] {
  const pool = config.adapters['cc-pool'];
  if (!pool) return [];

  const checkGrowth = (cfg: CcPoolAdapterConfig, name: string | null) => {
    if (cfg.growth === 'fixed' && cfg.max_panes !== undefined && cfg.max_panes < cfg.panes) {
      const label = name === null ? 'cc-pool config' : `cc-pool instance "${name}"`;
      throw new Error(
        `${label} has growth: 'fixed' with max_panes (${cfg.max_panes}) below panes ` +
          `(${cfg.panes}) — fixed pools ignore max_panes, so remove it or set it to at least panes`,
      );
    }
  };

  // Discriminate: the single-instance form has `agent_id` (required) at the top level.
  if (typeof (pool as { agent_id?: unknown }).agent_id === 'string') {
    const cfg = pool as CcPoolAdapterConfig;
    checkGrowth(cfg, null);
    return [{ name: null, ...cfg }];
  }

  const record = pool as Record<string, CcPoolAdapterConfig>;
  const seenAgentIds = new Set<string>();
  const seenTmuxSessions = new Set<string>();
  const instances: CcPoolInstanceConfig[] = [];

  const VALID_INSTANCE_NAME_RE = /^[a-z0-9_-]+$/;

  for (const [name, cfg] of Object.entries(record)) {
    if (!VALID_INSTANCE_NAME_RE.test(name)) {
      throw new Error(
        `Invalid cc-pool instance name "${name}" — only lowercase letters, digits, hyphens, and underscores are allowed`,
      );
    }
    if (seenAgentIds.has(cfg.agent_id)) {
      throw new Error(
        `Duplicate cc-pool agent_id "${cfg.agent_id}" for instance "${name}" — each pool must have a unique agent_id`,
      );
    }
    seenAgentIds.add(cfg.agent_id);
    if (seenTmuxSessions.has(cfg.tmux_session)) {
      throw new Error(
        `Duplicate cc-pool tmux_session "${cfg.tmux_session}" for instance "${name}" — each pool must have a unique tmux_session`,
      );
    }
    seenTmuxSessions.add(cfg.tmux_session);
    checkGrowth(cfg, name);
    instances.push({ name, ...cfg });
  }

  return instances;
}

/**
 * Resolve the per-channel journaling threshold (ms) from a `threshold_ms`
 * config value. Mirrors `SessionTracker.minMessagesForChannel`:
 *   - flat number: applies to every channel
 *   - record: channel-specific value, falling back to the required `default`
 */
export function journalingThresholdForChannel(
  threshold: number | Record<string, number>,
  channel: string,
): number {
  if (typeof threshold === 'number') return threshold;
  return threshold[channel] ?? threshold['default'];
}
