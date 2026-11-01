/**
 * E89 — notification tools: `notify`, `update_notification`, `list_notifications`.
 * They call the bus's internal notification routes (shared bus auth), which
 * share their handlers with the token-authenticated HTTP API.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';
import { originFromEnv } from '../../core/origin.js';

const BASE = '/api/v1/internal/notifications';

async function call(busBaseUrl: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${busBaseUrl}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let data: Record<string, unknown> = {};
  try { data = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON error body */ }
  return { status: res.status, data };
}

const failure = (what: string, status: number, data: Record<string, unknown>) =>
  toolError(`${what}: ${String(data['detail'] ?? data['error'] ?? `HTTP ${status}`)}${status === 404 && !data['error'] ? ' (notifications are not enabled on this bus)' : ''}`);

export function registerNotificationTools(server: McpServer, busBaseUrl: string, agentId: string): void {
  server.registerTool(
    'notify',
    {
      description:
        'Raise a short-lived "needs you soon" item on the operator\'s Intercom dial (leaving time, a bill due today, a draft awaiting approval, a background job finished). ' +
        'It makes the dial glow for attention/urgent and can offer up to 3 action buttons; a tap on one reaches the Intercom conversation as "[tapped] <label>". ' +
        'A "Got it" dismiss button is always added automatically, so do not include one in `actions`; actions should be real choices. ' +
        'Pass a `key` for anything you may resolve or refresh later: the same key while the item is open updates it in place. ' +
        'Use send_message/reply for content, not notify. Title is cut at 60 characters, body at 280.',
      inputSchema: {
        title: z.string().min(1).describe('What needs the operator (60 characters at most)'),
        body: z.string().optional().describe('One line of detail (280 characters at most)'),
        level: z.enum(['info', 'attention', 'urgent']).optional().describe('info: a quiet note, no glow. attention (default): amber glow. urgent: pulsing glow.'),
        key: z.string().min(1).optional().describe('Stable key; the same key while the item is open updates it in place'),
        targets: z.array(z.string().min(1)).optional().describe('Surface ids, or ["*"] for all (default)'),
        expires_in_s: z.number().int().positive().optional().describe('Seconds until the item expires on its own'),
        actions: z.array(z.object({
          label: z.string().min(1).describe('Button label, 24 characters at most'),
          style: z.enum(['primary', 'success', 'danger']).optional(),
        })).max(3).optional().describe('Up to 3 action buttons for real choices; a "Got it" dismiss button is added automatically, so do not include one'),
        source: z.string().min(1).optional().describe('Where this comes from; defaults to this agent'),
      },
    },
    async (args) => {
      try {
        const source = args.source?.trim() || originFromEnv(agentId).label || `Agent: ${agentId}`;
        const { status, data } = await call(busBaseUrl, 'POST', BASE, { ...args, source });
        if (!data['ok']) return failure('Bus rejected notification', status, data);
        return toolSuccess({ id: data['id'], key: data['key'], state: data['state'] });
      } catch (err) {
        return toolError(`Failed to send notification: ${String(err)}`);
      }
    },
  );

  server.registerTool(
    'update_notification',
    {
      description:
        'Change or clear a notification you raised, by id or key. Set state "resolved" when the thing is done (it disappears from the dial); ' +
        '"acknowledged" to quiet it without removing it; "active" to bring it back. Resolved and expired items cannot be changed.',
      inputSchema: {
        id: z.string().min(1).optional().describe('Notification id (from notify)'),
        key: z.string().min(1).optional().describe('Or the key of an open notification'),
        title: z.string().min(1).optional(),
        body: z.string().optional(),
        level: z.enum(['info', 'attention', 'urgent']).optional(),
        state: z.enum(['resolved', 'acknowledged', 'active']).optional(),
        expires_in_s: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      if (!args.id && !args.key) return toolError('Pass id or key');
      try {
        const { id, key, ...rest } = args;
        const path = id ? `${BASE}/${encodeURIComponent(id)}` : `${BASE}?key=${encodeURIComponent(key!)}`;
        const { status, data } = await call(busBaseUrl, 'PATCH', path, rest);
        if (!data['ok']) return failure('Bus rejected update', status, data);
        return toolSuccess({ id: data['id'], key: data['key'], state: data['state'] });
      } catch (err) {
        return toolError(`Failed to update notification: ${String(err)}`);
      }
    },
  );

  server.registerTool(
    'list_notifications',
    {
      description: 'List notifications, newest first. state: "active", "open" (default: active plus acknowledged) or "all".',
      inputSchema: {
        state: z.enum(['active', 'open', 'all']).optional().describe('Default "open" (active plus acknowledged)'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ state, limit }) => {
      try {
        const q = new URLSearchParams({ state: state ?? 'open', ...(limit ? { limit: String(limit) } : {}) });
        const { status, data } = await call(busBaseUrl, 'GET', `${BASE}?${q}`);
        if (!data['ok']) return failure('Bus rejected request', status, data);
        return toolSuccess({ notifications: data['notifications'] });
      } catch (err) {
        return toolError(`Failed to list notifications: ${String(err)}`);
      }
    },
  );
}
