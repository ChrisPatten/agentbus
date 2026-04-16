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

const ClaudeCodeAdapterSchema = z.object({
  poll_interval_ms: z.number().int().positive().default(1000),
  sampling_max_tokens: z.number().int().positive().default(8192),
  plugin: z.string().optional(),
});

const AdaptersConfigSchema = z.object({
  telegram: z.union([TelegramAdapterSchema, z.record(z.string(), TelegramAdapterSchema)]).optional(),
  bluebubbles: BlueBubblesAdapterSchema.optional(),
  'claude-code': ClaudeCodeAdapterSchema.optional(),
});

const MemoryConfigSchema = z.object({
  summarizer_interval_ms: z.number().int().positive().default(60000),
  session_idle_threshold_ms: z.number().int().positive().default(1800000),
  context_window_hours: z.number().positive().default(48),
  claude_api_model: z.string().default('claude-sonnet-4-6'),
  /** Max tokens for the summarization API response (default: 8192) */
  summary_max_tokens: z.number().int().positive().default(8192),
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
 * Controls every aspect of inbound message processing: deduplication window,
 * unrouted-message behaviour, topic classification rules, priority scoring
 * weights, and routing rules. All fields have sensible defaults so an empty
 * pipeline: {} block is valid.
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
    topic: z.string().default('general'),
    priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
    max_fires: z.number().int().positive().optional(),
  })
  .refine((d) => !!(d.cron ?? d.fire_at), {
    message: 'Each schedule entry must specify either cron or fire_at',
  })
  .refine(
    (d) => {
      if (!d.fire_at) return true;
      return !isNaN(new Date(d.fire_at).getTime());
    },
    { message: 'fire_at must be a valid ISO 8601 timestamp' },
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
  }),
  topics: z.array(z.string()).default(['general']),
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
  }),
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

  for (const [name, cfg] of Object.entries(record)) {
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
