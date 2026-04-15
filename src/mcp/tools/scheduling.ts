/**
 * E18 — Schedule tools: schedule_message, list_schedules, cancel_schedule
 *
 * These tools call the bus HTTP API schedule endpoints.
 * Agents use them to create, list, and cancel scheduled message deliveries.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

interface ScheduleCreateResponse {
  ok: boolean;
  id?: string;
  fire_at?: string;
  error?: string;
}

interface ScheduleRow {
  id: string;
  type: string;
  cron_expr: string | null;
  timezone: string;
  fire_at: string;
  channel: string;
  sender: string;
  payload_body: string;
  topic: string;
  priority: string;
  label: string | null;
  created_by: string;
  fire_count: number;
  max_fires: number | null;
  status: string;
  last_fired_at: string | null;
}

interface ScheduleListResponse {
  ok: boolean;
  schedules?: ScheduleRow[];
  count?: number;
  error?: string;
}

interface ScheduleDeleteResponse {
  ok: boolean;
  id?: string;
  error?: string;
}

export function registerScheduleTools(server: McpServer, busBaseUrl: string): void {
  // ── schedule_message ───────────────────────────────────────────────────────

  server.registerTool(
    'schedule_message',
    {
      description:
        'Schedule a message to be delivered on a channel at a future time or on a recurring cron schedule. ' +
        'The message will appear to the agent as if the specified sender sent it on that channel.',
      inputSchema: {
        type: z
          .enum(['once', 'cron'])
          .describe('"once" for a one-shot delivery; "cron" for a recurring schedule'),
        prompt: z
          .string()
          .min(1)
          .describe('The message text to deliver (appears as if the sender typed it)'),
        channel: z.string().min(1).describe('Target channel (e.g. "telegram")'),
        sender: z
          .string()
          .min(1)
          .describe('Sender identity (e.g. "contact:chris") — who the message appears to be from'),
        cron_expr: z
          .string()
          .optional()
          .describe('Cron expression (required when type=cron). Example: "0 8 * * 1-5"'),
        fire_at: z
          .string()
          .optional()
          .describe('ISO 8601 timestamp for one-shot delivery (required when type=once). Must be in the future.'),
        timezone: z
          .string()
          .optional()
          .default('UTC')
          .describe('IANA timezone for cron scheduling (e.g. "America/New_York"). Default: UTC'),
        topic: z.string().optional().default('general').describe('Message topic (default: general)'),
        priority: z
          .enum(['normal', 'high', 'urgent'])
          .optional()
          .default('normal')
          .describe('Message priority (default: normal)'),
        label: z
          .string()
          .optional()
          .describe('Optional human-readable name for this schedule (shown in /schedule list)'),
        max_fires: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of times to fire (for cron schedules). Null/omitted = unlimited.'),
      },
    },
    async ({ type, prompt, channel, sender, cron_expr, fire_at, timezone, topic, priority, label, max_fires }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/schedules`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type,
            payload_body: prompt,
            channel,
            sender,
            cron_expr,
            fire_at,
            timezone,
            topic,
            priority,
            label,
            max_fires,
            created_by: 'agent',
          }),
        });
        const data = (await res.json()) as ScheduleCreateResponse;
        if (!res.ok) {
          return toolError(`Failed to create schedule: ${data.error ?? `HTTP ${res.status}`}`);
        }
        return toolSuccess({
          ok: true,
          id: data.id,
          fire_at: data.fire_at,
          label: label ?? null,
        });
      } catch (err) {
        return toolError(`Failed to create schedule: ${String(err)}`);
      }
    },
  );

  // ── list_schedules ─────────────────────────────────────────────────────────

  server.registerTool(
    'list_schedules',
    {
      description: 'List scheduled messages. Defaults to active schedules.',
      inputSchema: {
        status: z
          .enum(['active', 'paused', 'cancelled', 'completed'])
          .optional()
          .default('active')
          .describe('Filter by status (default: active)'),
        channel: z
          .string()
          .optional()
          .describe('Filter by channel (e.g. "telegram")'),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .default(20)
          .describe('Max results (default: 20, max: 200)'),
      },
    },
    async ({ status, channel, limit }) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (channel) params.set('channel', channel);
      if (limit) params.set('limit', String(limit));

      try {
        const res = await fetch(`${busBaseUrl}/api/v1/schedules?${params.toString()}`);
        const data = (await res.json()) as ScheduleListResponse;
        if (!res.ok) {
          return toolError(`Failed to list schedules: ${data.error ?? `HTTP ${res.status}`}`);
        }
        return toolSuccess({ schedules: data.schedules ?? [], count: data.count ?? 0 });
      } catch (err) {
        return toolError(`Failed to list schedules: ${String(err)}`);
      }
    },
  );

  // ── cancel_schedule ────────────────────────────────────────────────────────

  server.registerTool(
    'cancel_schedule',
    {
      description: 'Cancel a scheduled message by its ID. Has no effect if already cancelled or completed.',
      inputSchema: {
        id: z.string().min(1).describe('Schedule ID to cancel'),
      },
    },
    async ({ id }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/schedules/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        const data = (await res.json()) as ScheduleDeleteResponse;
        if (!res.ok) {
          return toolError(`Failed to cancel schedule: ${data.error ?? `HTTP ${res.status}`}`);
        }
        return toolSuccess({ ok: true, id: data.id });
      } catch (err) {
        return toolError(`Failed to cancel schedule: ${String(err)}`);
      }
    },
  );
}
