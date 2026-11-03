/**
 * E96 S96.5 — surface publishing tools: Events with action buttons, slot
 * overrides and widget data on Intercom surfaces, plus the answer-needed clear.
 * They call the bus's `/api/v1/surface-publish/*` routes (shared bus auth) and
 * name the calling agent with `agent_id`; the bus checks it against the
 * surface's `publishers` config. Bus errors are returned verbatim.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';
import { BOUNDS, COLOR_PALETTE, TRAVEL_MODES } from '../../surface/types.js';
import { TURN_CONVERSATION_ENV } from '../../core/origin.js';

const BASE = '/api/v1/surface-publish';
const ASSET_EXT: Record<string, 'image/png' | 'image/jpeg' | 'image/svg+xml'> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };

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
  'the device shows the draft before the tap fires, and the call is rejected without it. Same id again replaces the event and its buttons. ' +
  'Ring placement (Day Dial): an event with BOTH at and end is drawn as a ring segment; layer is "primary" (default; at most 1 at a time) or "overlap" (at most 2 at a time), ' +
  `color is #rgb, #rrggbb or one of ${COLOR_PALETTE.join('/')}, travel adds a travel wedge. detail (description ${BOUNDS.description}, location ${BOUNDS.location}, image = asset hash) fills the focus view. ` +
  'opens "conversation" (with conversation_id) makes a tap open that conversation instead of the focus view.';

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
        layer: z.enum(['primary', 'overlap']).optional().describe('Ring layer (needs at and end): primary (default, one at a time) or overlap (up to two at a time)'),
        color: z.string().optional().describe(`Ring segment colour (needs at and end): #rgb, #rrggbb or ${COLOR_PALETTE.join(', ')}`),
        travel: z.object({
          minutes: z.number().int().min(1).max(BOUNDS.travelMinutes),
          mode: z.enum(TRAVEL_MODES as unknown as [string, ...string[]]).optional(),
        }).optional().describe('Travel time before the event (needs at and end); drives the travel wedge and leave-by'),
        detail: z.object({
          description: z.string().optional().describe(`At most ${BOUNDS.description} characters`),
          location: z.string().optional().describe(`At most ${BOUNDS.location} characters`),
          image: z.string().optional().describe('Asset hash returned by surface_upload_asset (64 hex, or asset:<hash>)'),
        }).optional().describe('Focus view content shown when the segment is tapped'),
        opens: z.enum(['focus', 'conversation']).optional().describe('What a tap opens: focus view (default) or a conversation'),
        conversation_id: z.string().optional().describe('Required when opens is "conversation"'),
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
        `Temporarily override a named slot on the surface's face until a set time. Slots: "primary" (the text under the time; text at most ${BOUNDS.slotText} characters, ` +
        'optionally one action button with a job behind it, same shape as an Event button) and "context" (above the time: either lines, up to ' +
        `${BOUNDS.contextLines} strings of at most ${BOUNDS.contextLineText} characters, or widgets, up to ${BOUNDS.contextWidgets} ids of widgets you wrote with surface_write_widget; unknown ids are rejected). ` +
        `Other slot names take text only. until is required and at most ${BOUNDS.slotMaxHours} hours ahead; at most ${BOUNDS.slotsPerSurface} overrides per surface. ` +
        'Same slot again replaces it (and its button).',
      inputSchema: {
        surface: surfaceField,
        slot: idField('Slot name'),
        text: z.string().optional().describe(`Text shown in the slot, at most ${BOUNDS.slotText} characters (not for context lines/widgets)`),
        lines: z.array(z.string()).max(BOUNDS.contextLines).optional().describe(`context only: up to ${BOUNDS.contextLines} short lines`),
        widgets: z.array(z.string()).max(BOUNDS.contextWidgets).optional().describe(`context only: up to ${BOUNDS.contextWidgets} existing widget ids`),
        action: actionSchema.optional().describe('primary only: one button; run.body is what you receive when it is tapped'),
        icon: z.string().optional().describe('Icon name: 1-40 lowercase letters, digits, ., - or _'),
        color: z.string().optional().describe('#rgb, #rrggbb or a lowercase colour name'),
        until: z.string().min(1).describe(`ISO time the override ends, at most ${BOUNDS.slotMaxHours} hours ahead`),
      },
    },
    async ({ surface, slot, ...rest }) => run('set slot', 'PUT', path(surface, 'slots', slot), rest),
  );

  server.registerTool(
    'surface_set_face',
    {
      description:
        'Change an existing face of the surface: enable or disable it, reorder it, or give it a slot layout ' +
        '{ slots: { event_ring?: boolean, primary?: boolean, context?: "lines" | "widgets" } }. layout null removes the layout (the device default applies).',
      inputSchema: {
        surface: surfaceField,
        id: z.string().min(1).describe('Face id, e.g. day, status, desk'),
        enabled: z.boolean().optional(),
        order: z.number().int().min(0).max(99).optional(),
        layout: z.object({
          slots: z.object({
            event_ring: z.boolean().optional(),
            primary: z.boolean().optional(),
            context: z.enum(['lines', 'widgets']).optional(),
          }),
        }).nullable().optional(),
      },
    },
    async ({ surface, id, ...rest }) => run('set face', 'PUT', path(surface, 'faces', id), rest),
  );

  server.registerTool(
    'surface_upload_asset',
    {
      description:
        'Upload an image (PNG, JPEG or static SVG; a QR code is just a small PNG) to the surface asset store and get its content hash, ' +
        'which you then use as detail.image of an Event. Give either path (a file on this machine) or data_base64 with content_type. ' +
        'The store is content-addressed: the same bytes always give the same hash. Size limit comes from surface_api.asset_max_bytes (default 1 MiB).',
      inputSchema: {
        path: z.string().optional().describe('Local file path (.png, .jpg, .jpeg, .svg)'),
        data_base64: z.string().optional().describe('The file, base64-encoded (alternative to path)'),
        content_type: z.enum(['image/png', 'image/jpeg', 'image/svg+xml']).optional().describe('Required with data_base64; with path it follows the extension'),
      },
    },
    async ({ path: file, data_base64, content_type }) => {
      try {
        let bytes: Buffer;
        let type = content_type;
        if (file) {
          bytes = await readFile(file);
          type ??= ASSET_EXT[extname(file).toLowerCase()];
        } else if (data_base64) {
          bytes = Buffer.from(data_base64, 'base64');
        } else {
          return toolError('Pass path, or data_base64 with content_type');
        }
        if (!type) return toolError('Cannot tell the content type: pass content_type, or use a .png, .jpg, .jpeg or .svg path');
        const res = await fetch(`${busBaseUrl}${BASE}/assets?${q}`, { method: 'POST', headers: { 'Content-Type': type }, body: new Uint8Array(bytes) });
        let data: Record<string, unknown> = {};
        try { data = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON error body */ }
        if (!data['ok']) return failure(res.status, data);
        const { ok: _ok, ...rest } = data;
        return toolSuccess(rest);
      } catch (err) {
        return toolError(`Failed to upload asset: ${String(err)}`);
      }
    },
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
