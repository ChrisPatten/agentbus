/**
 * Headless model override tools.
 *
 * Provides tools to manage runtime model overrides for headless Claude spawns:
 * - set_headless_model: Set or update a model override
 * - get_headless_model: Get the current model for a given scope
 * - list_headless_model: List all active model overrides
 * - delete_headless_model: Remove a specific override
 *
 * These tools call the bus-core HTTP API to manage the headless_model_overrides table.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

interface ModelOverrideRow {
  id: number;
  schedule_id: string | null;
  agent_id: string | null;
  model: string;
  priority: number;
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

export function registerModelOverrideTools(server: McpServer, busBaseUrl: string): void {
  // ── set_headless_model ─────────────────────────────────────────────────────

  server.registerTool(
    'set_headless_model',
    {
      description:
        'Set or update a model override for headless Claude spawns. ' +
        'Specify model (required) and optionally schedule_id and/or agent_id to scope the override. ' +
        'If both are omitted, sets a global default. ' +
        'Priority field (default 0) is used to break ties when multiple overrides could apply.',
      inputSchema: {
        model: z.string().min(1).describe('Model name (e.g. "claude-3-5-opus-20241022")'),
        schedule_id: z.string().optional().describe('Limit override to a specific schedule ID'),
        agent_id: z.string().optional().describe('Limit override to a specific agent'),
        priority: z.number().int().optional().describe('Priority for tie-breaking (higher wins; default: 0)'),
      },
    },
    async ({ model, schedule_id, agent_id, priority }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/model-overrides`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            schedule_id,
            agent_id,
            priority,
          }),
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error?: string;
          };
          return toolError(`Failed to set model override: ${err.error ?? `HTTP ${res.status}`}`);
        }

        const data = (await res.json()) as SetOverrideResponse;
        if (!data.ok) {
          return toolError(`Bus rejected override: ${data.error ?? 'unknown error'}`);
        }

        const scope = [schedule_id && `schedule=${schedule_id}`, agent_id && `agent=${agent_id}`]
          .filter(Boolean)
          .join(', ') || 'global';
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

  // ── get_headless_model ─────────────────────────────────────────────────────

  server.registerTool(
    'get_headless_model',
    {
      description:
        'Get the currently active model for a given scope. ' +
        'Queries the override table with priority: (schedule + agent) > agent > schedule > global. ' +
        'Returns the model name if an override is found, or "not set, using config default" if none.',
      inputSchema: {
        schedule_id: z.string().optional().describe('Schedule ID to query'),
        agent_id: z.string().optional().describe('Agent ID to query'),
      },
    },
    async ({ schedule_id, agent_id }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/model-overrides`);
        if (!res.ok) {
          return toolError(`Failed to fetch model overrides: HTTP ${res.status}`);
        }

        const data = (await res.json()) as ListOverrideResponse;
        if (!data.ok || !data.overrides) {
          return toolError('Failed to list model overrides');
        }

        // Resolve model with priority logic matching server-side implementation
        let match: ModelOverrideRow | null = null;

        // Priority 1: both schedule_id and agent_id match
        if (schedule_id && agent_id) {
          match = data.overrides.find(
            (o) => o.schedule_id === schedule_id && o.agent_id === agent_id
          ) ?? null;
          if (match) return toolSuccess({ ok: true, model: match.model, scope: 'schedule+agent' });
        }

        // Priority 2: agent_id only
        if (agent_id) {
          match = data.overrides.find((o) => o.agent_id === agent_id && !o.schedule_id) ?? null;
          if (match) return toolSuccess({ ok: true, model: match.model, scope: 'agent' });
        }

        // Priority 3: schedule_id only
        if (schedule_id) {
          match = data.overrides.find((o) => o.schedule_id === schedule_id && !o.agent_id) ?? null;
          if (match) return toolSuccess({ ok: true, model: match.model, scope: 'schedule' });
        }

        // Priority 4: global
        match = data.overrides.find((o) => !o.schedule_id && !o.agent_id) ?? null;
        if (match) {
          return toolSuccess({ ok: true, model: match.model, scope: 'global' });
        }

        return toolSuccess({
          ok: true,
          model: null,
          message: 'No override found; using config default model',
        });
      } catch (err) {
        return toolError(`Failed to get model: ${String(err)}`);
      }
    }
  );

  // ── list_headless_model ────────────────────────────────────────────────────

  server.registerTool(
    'list_headless_model',
    {
      description:
        'List all active model overrides, ordered by specificity (schedule+agent > agent > schedule > global) ' +
        'and then by priority and recency.',
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
          return toolSuccess({
            ok: true,
            overrides: [],
            count: 0,
            message: 'No model overrides configured',
          });
        }

        const formatted = data.overrides.map((o) => ({
          id: o.id,
          scope:
            o.schedule_id && o.agent_id
              ? `schedule=${o.schedule_id}, agent=${o.agent_id}`
              : o.schedule_id
              ? `schedule=${o.schedule_id}`
              : o.agent_id
              ? `agent=${o.agent_id}`
              : 'global',
          model: o.model,
          priority: o.priority,
          created_at: o.created_at,
          updated_at: o.updated_at,
        }));

        return toolSuccess({
          ok: true,
          overrides: formatted,
          count: formatted.length,
        });
      } catch (err) {
        return toolError(`Failed to list model overrides: ${String(err)}`);
      }
    }
  );

  // ── delete_headless_model ──────────────────────────────────────────────────

  server.registerTool(
    'delete_headless_model',
    {
      description:
        'Delete a specific model override by scope, or clear all overrides. ' +
        'Pass schedule_id and/or agent_id to delete a specific override. ' +
        'Pass all=true to delete all overrides at once (irreversible).',
      inputSchema: {
        schedule_id: z.string().optional().describe('Schedule ID to delete'),
        agent_id: z.string().optional().describe('Agent ID to delete'),
        all: z
          .boolean()
          .optional()
          .describe('If true, delete all overrides (overrides schedule_id/agent_id; irreversible)'),
      },
    },
    async ({ schedule_id, agent_id, all }) => {
      try {
        const params = new URLSearchParams();
        if (all) {
          params.set('all', 'true');
        } else {
          if (schedule_id) params.set('schedule_id', schedule_id);
          if (agent_id) params.set('agent_id', agent_id);

          if (!schedule_id && !agent_id) {
            return toolError('Provide schedule_id or agent_id, or pass all=true to clear all');
          }
        }

        const qs = params.toString();
        const res = await fetch(`${busBaseUrl}/api/v1/model-overrides${qs ? `?${qs}` : ''}`, {
          method: 'DELETE',
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error?: string;
          };
          return toolError(`Failed to delete override: ${err.error ?? `HTTP ${res.status}`}`);
        }

        const data = (await res.json()) as DeleteOverrideResponse;
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
