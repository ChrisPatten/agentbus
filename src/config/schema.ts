import { z } from 'zod';

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

const ContactSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  platforms: ContactPlatformsSchema,
});

const BusConfigSchema = z.object({
  http_port: z.number().int().min(1).max(65535).default(3000),
  db_path: z.string(),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
  plugin: z.string().optional(),
});

const AdaptersConfigSchema = z.object({
  telegram: TelegramAdapterSchema.optional(),
  bluebubbles: BlueBubblesAdapterSchema.optional(),
  'claude-code': ClaudeCodeAdapterSchema.optional(),
});

const MemoryConfigSchema = z.object({
  summarizer_interval_ms: z.number().int().positive().default(60000),
  session_idle_threshold_ms: z.number().int().positive().default(1800000),
  context_window_hours: z.number().positive().default(48),
  claude_api_model: z.string().default('claude-opus-4-6'),
});

const PipelineConfigSchema = z.object({
  stages: z.array(z.string()).optional(),
});

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
  pipeline: PipelineConfigSchema.default({}),
});

/** Fully-typed application configuration */
export type AppConfig = z.infer<typeof AppConfigSchema>;
