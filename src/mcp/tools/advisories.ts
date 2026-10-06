/**
 * E65 — advisory_ack: the agent acknowledges a bus advisory after relaying
 * it to its owner. The bus checks the advisory belongs to this agent (a
 * pool pane maps to its pool) via POST /api/v1/advisories/:id/ack.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

interface AckResponse {
  ok: boolean;
  error?: string;
  already_acknowledged?: boolean;
  advisory?: { id: string; state: string; condition_key: string };
}

/**
 * @param agentId - BARE agent id of the calling instance (e.g. "baxter",
 *                  "peggy-pool-3"); sent as the acknowledging agent.
 */
export function registerAdvisoryTools(server: McpServer, busBaseUrl: string, agentId: string): void {
  server.registerTool(
    'advisory_ack',
    {
      description:
        'Acknowledge a bus advisory after you have told your owner about it. Advisories arrive in an ' +
        '<agentbus-system kind="advisories"> block at the start of a turn; pass the id listed there.',
      inputSchema: {
        id: z.string().min(1).describe('Advisory id from the agentbus-system block'),
      },
    },
    async ({ id }: { id: string }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/advisories/${encodeURIComponent(id)}/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agentId }),
        });
        const data = (await res.json().catch(() => ({}))) as AckResponse;
        if (res.status === 404) return toolError(`Advisory not found: ${id}`);
        if (res.status === 403) return toolError(`Advisory ${id} belongs to another agent`);
        if (res.status === 409) return toolError(`Advisory ${id} is already resolved; nothing to acknowledge`);
        if (!res.ok || !data.ok) return toolError(`Acknowledge failed: ${data.error ?? `HTTP ${res.status}`}`);
        return toolSuccess({ success: true, id, state: data.advisory?.state, already_acknowledged: data.already_acknowledged });
      } catch (err) {
        return toolError(`Failed to acknowledge advisory: ${String(err)}`);
      }
    },
  );
}
