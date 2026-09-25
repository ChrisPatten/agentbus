/**
 * Model override tools (E53 S53.1).
 *
 * Agent-wide and global runtime model overrides, shared by cc-headless and
 * cc-pool:
 * - set_model_override / get_model_override / list_model_overrides / delete_model_override
 *
 * A job's own model lives on its schedule (`scheduled_items.model`), not
 * here — see the scheduling tools and docs/SCHEDULING.md.
 *
 * `set_headless_model`, `get_headless_model`, `list_headless_model`, and
 * `delete_headless_model` are kept as deprecated aliases for the equivalent
 * *_model_override tools, for one minor release. Passing `schedule_id` to
 * any of them returns an error pointing at the schedule's `model` field.
 *
 * All of these call the bus-core HTTP API to manage the `model_overrides`
 * table.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

interface ModelOverrideRow {
  id: number;
  agent_id: string | null;
  model: string;
  created_at: string;
  updated_at: string;
}

interface SetOverrideResponse {
  ok: boolean;
  id?: number;
  override?: ModelOverrideRow;
  error?: string;
}

interface ListOverrideResponse {
  ok: boolean;
  overrides?: ModelOverrideRow[];
  count?: number;
  error?: string;
}

interface DeleteOverrideResponse {
  ok: boolean;
  deleted_count?: number;
  message?: string;
  error?: string;
}

const SCHEDULE_ID_REJECTION =
  "A job's model now lives on its schedule (the schedule's `model` field), not on a schedule-scoped override. " +
  'Use the scheduling tools (e.g. `update_schedule` / PATCH /api/v1/schedules/:id) to set it there instead.';

export function registerModelOverrideTools(server: McpServer, busBaseUrl: string): void {
  // ── set_model_override ───────────────────────────────────────────────────

  server.registerTool(
    'set_model_override',
    {
      description:
        'Set or update a runtime model override. Specify model (required) and optionally agent_id to scope ' +
        'the override to one agent. Omit agent_id for a global default. Used by cc-headless and cc-pool.',
      inputSchema: {
        model: z.string().min(1).describe('Model name (e.g. "sonnet", "opus")'),
        agent_id: z.string().optional().describe('Limit the override to one agent (e.g. "agent:claude")'),
      },
    },
    async ({ model, agent_id }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/model-overrides`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, agent_id }),
        });

        const data = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as SetOverrideResponse;
        if (!res.ok || !data.ok) {
          return toolError(`Failed to set model override: ${data.error ?? `HTTP ${res.status}`}`);
        }

        const scope = agent_id ? `agent=${agent_id}` : 'global';
        return toolSuccess({
          ok: true,
          id: data.id,
          model,
          scope,
          message: `Model override set to ${model} (${scope})`,
        });
      } catch (err) {
        return toolError(`Failed to set model override: ${String(err)}`);
      }
    }
  );

  // ── get_model_override ───────────────────────────────────────────────────

  server.registerTool(
    'get_model_override',
    {
      description:
        'Get the currently active model override for a scope. Checks the agent-scoped override first, then ' +
        'the global one. Returns null if neither is set (the caller falls back to its configured model).',
      inputSchema: {
        agent_id: z.string().optional().describe('Agent id to query (e.g. "agent:claude")'),
      },
    },
    async ({ agent_id }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/model-overrides`);
        if (!res.ok) {
          return toolError(`Failed to fetch model overrides: HTTP ${res.status}`);
        }

        const data = (await res.json()) as ListOverrideResponse;
        if (!data.ok || !data.overrides) {
          return toolError('Failed to list model overrides');
        }

        if (agent_id) {
          const match = data.overrides.find((o) => o.agent_id === agent_id);
          if (match) return toolSuccess({ ok: true, model: match.model, scope: 'agent' });
        }

        const global = data.overrides.find((o) => !o.agent_id);
        if (global) {
          return toolSuccess({ ok: true, model: global.model, scope: 'global' });
        }

        return toolSuccess({
          ok: true,
          model: null,
          message: 'No override found; using the configured default model',
        });
      } catch (err) {
        return toolError(`Failed to get model: ${String(err)}`);
      }
    }
  );

  // ── list_model_overrides ─────────────────────────────────────────────────

  server.registerTool(
    'list_model_overrides',
    {
      description: 'List all active model overrides, agent-scoped rows first, then the global override.',
      inputSchema: {},
    },
    async () => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/model-overrides`);
        if (!res.ok) {
          return toolError(`Failed to fetch model overrides: HTTP ${res.status}`);
        }

        const data = (await res.json()) as ListOverrideResponse;
        if (!data.ok || !data.overrides) {
          return toolError('Failed to list model overrides');
        }

        if (data.overrides.length === 0) {
          return toolSuccess({ ok: true, overrides: [], count: 0, message: 'No model overrides configured' });
        }

        const formatted = data.overrides.map((o) => ({
          id: o.id,
          scope: o.agent_id ? `agent=${o.agent_id}` : 'global',
          model: o.model,
          created_at: o.created_at,
          updated_at: o.updated_at,
        }));

        return toolSuccess({ ok: true, overrides: formatted, count: formatted.length });
      } catch (err) {
        return toolError(`Failed to list model overrides: ${String(err)}`);
      }
    }
  );

  // ── delete_model_override ────────────────────────────────────────────────

  server.registerTool(
    'delete_model_override',
    {
      description:
        'Delete a model override by scope, or clear all of them. Pass agent_id to delete one agent\'s ' +
        'override, scope="global" to delete the global one, or all=true to delete every override (irreversible).',
      inputSchema: {
        agent_id: z.string().optional().describe('Agent id to delete'),
        scope: z.literal('global').optional().describe('Pass "global" to delete the global override'),
        all: z.boolean().optional().describe('If true, delete every override (irreversible)'),
      },
    },
    async ({ agent_id, scope, all }) => {
      try {
        const params = new URLSearchParams();
        if (all) {
          params.set('all', 'true');
        } else if (scope === 'global') {
          params.set('scope', 'global');
        } else if (agent_id) {
          params.set('agent_id', agent_id);
        } else {
          return toolError('Provide agent_id, or scope="global", or all=true to clear all');
        }

        const res = await fetch(`${busBaseUrl}/api/v1/model-overrides?${params.toString()}`, { method: 'DELETE' });
        const data = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as DeleteOverrideResponse;
        if (!res.ok || !data.ok) {
          return toolError(`Failed to delete override: ${data.error ?? `HTTP ${res.status}`}`);
        }

        return toolSuccess({
          ok: true,
          deleted_count: data.deleted_count,
          message: data.message ?? 'Override(s) deleted',
        });
      } catch (err) {
        return toolError(`Failed to delete model override: ${String(err)}`);
      }
    }
  );

  // ── Deprecated aliases (headless_model naming, kept for one minor release) ──

  server.registerTool(
    'set_headless_model',
    {
      description:
        'Deprecated: use set_model_override instead. Set or update a runtime model override, scoped to an ' +
        'agent or global.',
      inputSchema: {
        model: z.string().min(1).describe('Model name (e.g. "sonnet", "opus")'),
        agent_id: z.string().optional().describe('Limit the override to one agent'),
        schedule_id: z.string().optional().describe('Deprecated and unsupported; see the error this returns'),
      },
    },
    async ({ model, agent_id, schedule_id }) => {
      if (schedule_id) return toolError(SCHEDULE_ID_REJECTION);
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/model-overrides`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, agent_id }),
        });
        const data = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as SetOverrideResponse;
        if (!res.ok || !data.ok) {
          return toolError(`Failed to set model override: ${data.error ?? `HTTP ${res.status}`}`);
        }
        const scope = agent_id ? `agent=${agent_id}` : 'global';
        return toolSuccess({
          ok: true,
          id: data.id,
          model,
          scope,
          message: `Model override set to ${model} (${scope})`,
        });
      } catch (err) {
        return toolError(`Failed to set model override: ${String(err)}`);
      }
    }
  );

  server.registerTool(
    'get_headless_model',
    {
      description: 'Deprecated: use get_model_override instead. Get the currently active model override.',
      inputSchema: {
        agent_id: z.string().optional().describe('Agent id to query'),
        schedule_id: z.string().optional().describe('Deprecated and unsupported; see the error this returns'),
      },
    },
    async ({ agent_id, schedule_id }) => {
      if (schedule_id) return toolError(SCHEDULE_ID_REJECTION);
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/model-overrides`);
        if (!res.ok) return toolError(`Failed to fetch model overrides: HTTP ${res.status}`);
        const data = (await res.json()) as ListOverrideResponse;
        if (!data.ok || !data.overrides) return toolError('Failed to list model overrides');

        if (agent_id) {
          const match = data.overrides.find((o) => o.agent_id === agent_id);
          if (match) return toolSuccess({ ok: true, model: match.model, scope: 'agent' });
        }
        const global = data.overrides.find((o) => !o.agent_id);
        if (global) return toolSuccess({ ok: true, model: global.model, scope: 'global' });
        return toolSuccess({ ok: true, model: null, message: 'No override found; using config default model' });
      } catch (err) {
        return toolError(`Failed to get model: ${String(err)}`);
      }
    }
  );

  server.registerTool(
    'list_headless_model',
    {
      description: 'Deprecated: use list_model_overrides instead. List all active model overrides.',
      inputSchema: {},
    },
    async () => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/model-overrides`);
        if (!res.ok) return toolError(`Failed to fetch model overrides: HTTP ${res.status}`);
        const data = (await res.json()) as ListOverrideResponse;
        if (!data.ok || !data.overrides) return toolError('Failed to list model overrides');
        if (data.overrides.length === 0) {
          return toolSuccess({ ok: true, overrides: [], count: 0, message: 'No model overrides configured' });
        }
        const formatted = data.overrides.map((o) => ({
          id: o.id,
          scope: o.agent_id ? `agent=${o.agent_id}` : 'global',
          model: o.model,
          created_at: o.created_at,
          updated_at: o.updated_at,
        }));
        return toolSuccess({ ok: true, overrides: formatted, count: formatted.length });
      } catch (err) {
        return toolError(`Failed to list model overrides: ${String(err)}`);
      }
    }
  );

  server.registerTool(
    'delete_headless_model',
    {
      description: 'Deprecated: use delete_model_override instead. Delete a model override, or clear all.',
      inputSchema: {
        agent_id: z.string().optional().describe('Agent id to delete'),
        schedule_id: z.string().optional().describe('Deprecated and unsupported; see the error this returns'),
        all: z.boolean().optional().describe('If true, delete every override (irreversible)'),
      },
    },
    async ({ agent_id, schedule_id, all }) => {
      if (schedule_id) return toolError(SCHEDULE_ID_REJECTION);
      try {
        const params = new URLSearchParams();
        if (all) {
          params.set('all', 'true');
        } else if (agent_id) {
          params.set('agent_id', agent_id);
        } else {
          return toolError('Provide agent_id, or all=true to clear all');
        }
        const res = await fetch(`${busBaseUrl}/api/v1/model-overrides?${params.toString()}`, { method: 'DELETE' });
        const data = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as DeleteOverrideResponse;
        if (!res.ok || !data.ok) {
          return toolError(`Failed to delete override: ${data.error ?? `HTTP ${res.status}`}`);
        }
        return toolSuccess({
          ok: true,
          deleted_count: data.deleted_count,
          message: data.message ?? 'Override(s) deleted',
        });
      } catch (err) {
        return toolError(`Failed to delete model override: ${String(err)}`);
      }
    }
  );
}
