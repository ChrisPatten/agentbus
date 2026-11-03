/**
 * E96 S96.5 — surface publishing tools: Events with action buttons, slot
 * overrides and widget data on Intercom surfaces, plus the answer-needed clear.
 * They call the bus's `/api/v1/surface-publish/*` routes (shared bus auth) and
 * name the calling agent with `agent_id`; the bus checks it against the
 * surface's `publishers` config. Bus errors are returned verbatim.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';
import { BOUNDS } from '../../surface/types.js';
import { TURN_CONVERSATION_ENV } from '../../core/origin.js';

const BASE = '/api/v1/surface-publish';

async function call(busBaseUrl: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${busBaseUrl}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let data: Record<string, unknown> = {};
  try { data = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON error body */ }
  return { status: res.status, data };
}

const failure = (status: number, data: Record<string, unknown>) =>
  toolError(String(data['error'] ?? (status === 404 ? 'surface publishing is not enabled on this bus' : `HTTP ${status}`)));

const surfaceField = z.string().min(1).describe('Surface id (list_surfaces shows the ones you may publish to)');
const idField = (what: string) => z.string().min(1).max(64).describe(`${what}: 1-64 lowercase letters, digits, - or _. Reusing an id replaces that item.`);

export const EVENT_DESCRIPTION =
  'Create or replace an Event card on an Intercom surface (e.g. "Train in 10 min", "Package delivered") with up to ' +
  `${BOUNDS.actionsPerObject} action buttons. Bounds: title ${BOUNDS.title} characters, body ${BOUNDS.body}, button label ${BOUNDS.actionLabel}, ` +
  `run.body ${BOUNDS.jobPayload}, confirm.draft ${BOUNDS.draft}; at most ${BOUNDS.eventsPerSurface} live events per surface. ` +
  `expires_at defaults to 24 hours from now and may be at most ${BOUNDS.eventMaxDays} days ahead; the card and its buttons go away then. ` +
  'Each button carries `run.body`: the message you receive in the surface\'s followed conversation when it is tapped (once by default). ' +
  'Rule: a button that sends something on the user\'s behalf must set run.sends_on_behalf true AND confirm.draft to the exact text that will be sent; ' +
  'the device shows the draft before the tap fires, and the call is rejected without it. Same id again replaces the event and its buttons.';

const actionSchema = z.object({
  id: z.string().min(1).max(32).describe('Button id, unique within the event: 1-32 lowercase letters, digits, - or _'),
  label: z.string().min(1).describe(`Button label, at most ${BOUNDS.actionLabel} characters`),
  style: z.enum(['default', 'primary', 'destructive']).optional(),
  confirm: z.object({
    draft: z.string().min(1).describe(`Exact text that will be sent on the user's behalf, shown verbatim before the tap fires (at most ${BOUNDS.draft} characters)`),
    prompt: z.string().optional().describe(`Short question shown with the draft (at most ${BOUNDS.title} characters)`),
  }).optional().describe('Required when run.sends_on_behalf is true'),
  once: z.boolean().optional().describe('One-shot (default true): later taps answer already_done'),
  run: z.object({
    body: z.string().min(1).describe(`Message injected into the followed conversation when tapped, as if the user sent it (at most ${BOUNDS.jobPayload} characters)`),
    sends_on_behalf: z.boolean().optional().describe('True when acting on this message sends something as the user; requires confirm.draft'),
  }),
});

export function registerSurfaceTools(server: McpServer, busBaseUrl: string, agentId: string): void {
  const q = `agent_id=${encodeURIComponent(agentId)}`;
  const path = (surface: string, kind: string, id: string) => `${BASE}/${encodeURIComponent(surface)}/${kind}/${encodeURIComponent(id)}`;
  const run = async (what: string, method: string, url: string, body?: Record<string, unknown>) => {
    try {
      const { status, data } = await call(busBaseUrl, method, url, body === undefined ? undefined : { ...body, agent_id: agentId });
      if (!data['ok']) return failure(status, data);
      const { ok: _ok, ...rest } = data;
      return toolSuccess(rest);
    } catch (err) {
      return toolError(`Failed to ${what}: ${String(err)}`);
    }
  };

  server.registerTool(
    'list_surfaces',
    { description: 'List the Intercom surfaces you may publish Events, slot overrides and widgets to, with the conversation each one follows (where button taps arrive).' },
    async () => run('list surfaces', 'GET', `${BASE}/surfaces?${q}`),
  );

  server.registerTool(
    'surface_publish_event',
    {
      description: EVENT_DESCRIPTION,
      inputSchema: {
        surface: surfaceField,
        id: idField('Event id'),
        title: z.string().min(1).describe(`Card title, at most ${BOUNDS.title} characters`),
        body: z.string().optional().describe(`Detail text, at most ${BOUNDS.body} characters`),
        level: z.enum(['info', 'attention', 'urgent']).optional().describe('info (default), attention or urgent'),
        at: z.string().optional().describe('ISO time the event is about (e.g. a train departure), for placement on the day dial'),
        end: z.string().optional().describe('ISO end time (needs at)'),
        expires_at: z.string().optional().describe(`ISO time the card disappears; default 24 hours from now, at most ${BOUNDS.eventMaxDays} days ahead`),
        actions: z.array(actionSchema).max(BOUNDS.actionsPerObject).optional().describe(`Up to ${BOUNDS.actionsPerObject} buttons`),
      },
    },
    async ({ surface, id, ...event }) => run('publish event', 'PUT', path(surface, 'events', id), event),
  );

  server.registerTool(
    'surface_remove_event',
    { description: 'Remove an Event you published (its buttons stop working).', inputSchema: { surface: surfaceField, id: z.string().min(1).describe('Event id') } },
    async ({ surface, id }) => run('remove event', 'DELETE', `${path(surface, 'events', id)}?${q}`),
  );

  server.registerTool(
    'surface_set_slot',
    {
      description:
        `Temporarily override a named slot on the surface's face (e.g. the status line) until a set time. text at most ${BOUNDS.slotText} characters; ` +
        `until is required and at most ${BOUNDS.slotMaxHours} hours ahead; at most ${BOUNDS.slotsPerSurface} overrides per surface. Same slot again replaces it.`,
      inputSchema: {
        surface: surfaceField,
        slot: idField('Slot name'),
        text: z.string().min(1).describe(`Text shown in the slot, at most ${BOUNDS.slotText} characters`),
        icon: z.string().optional().describe('Icon name: 1-40 lowercase letters, digits, ., - or _'),
        color: z.string().optional().describe('#rgb, #rrggbb or a lowercase colour name'),
        until: z.string().min(1).describe(`ISO time the override ends, at most ${BOUNDS.slotMaxHours} hours ahead`),
      },
    },
    async ({ surface, slot, ...rest }) => run('set slot', 'PUT', path(surface, 'slots', slot), rest),
  );

  server.registerTool(
    'surface_clear_slot',
    { description: 'End a slot override early.', inputSchema: { surface: surfaceField, slot: z.string().min(1).describe('Slot name') } },
    async ({ surface, slot }) => run('clear slot', 'DELETE', `${path(surface, 'slots', slot)}?${q}`),
  );

  server.registerTool(
    'surface_write_widget',
    {
      description:
        `Write the data for a widget the surface renders (e.g. type "weather" or "countdown"). data is a JSON object of at most ${BOUNDS.widgetDataBytes} bytes; ` +
        `at most ${BOUNDS.widgetsPerSurface} widgets per surface. Same id again replaces the data.`,
      inputSchema: {
        surface: surfaceField,
        id: idField('Widget id'),
        type: z.string().min(1).max(40).describe('Widget type: 1-40 lowercase letters, digits, ., - or _'),
        data: z.record(z.string(), z.unknown()).describe(`Widget data, a JSON object of at most ${BOUNDS.widgetDataBytes} bytes`),
      },
    },
    async ({ surface, id, ...rest }) => run('write widget', 'PUT', path(surface, 'widgets', id), rest),
  );

  server.registerTool(
    'surface_remove_widget',
    { description: 'Remove a widget from the surface.', inputSchema: { surface: surfaceField, id: z.string().min(1).describe('Widget id') } },
    async ({ surface, id }) => run('remove widget', 'DELETE', `${path(surface, 'widgets', id)}?${q}`),
  );

  server.registerTool(
    'clear_answer_needed',
    {
      description:
        'Clear the needs-you mark left by a reply or send_message with answer_needed, when you no longer need the answer. ' +
        'It also clears by itself when the user answers or taps a button. Pass conversation_id, or channel and contact (and topic); ' +
        'with none of them it clears the conversation of your current turn.',
      inputSchema: {
        conversation_id: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        contact: z.string().min(1).optional().describe('e.g. "contact:chris" or "chris"'),
        topic: z.string().min(1).optional(),
      },
    },
    async (args) => {
      const conversationId = args.conversation_id ?? (args.channel || args.contact ? undefined : process.env[TURN_CONVERSATION_ENV] || undefined);
      if (!conversationId && !(args.channel && args.contact)) {
        return toolError('Pass conversation_id, or channel and contact (and topic for a forum topic)');
      }
      const body = conversationId ? { conversation_id: conversationId } : { channel: args.channel, contact: args.contact, ...(args.topic ? { topic: args.topic } : {}) };
      return run('clear answer needed', 'POST', `${BASE}/answer-needed/clear`, body);
    },
  );
}
