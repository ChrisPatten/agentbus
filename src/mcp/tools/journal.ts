/**
 * E66 — journal_complete: the agent reports that a System Message journal
 * run is finished (POST /api/v1/journal/complete). The run id comes from the
 * <agentbus-system kind="journal" run_id="…"> block; the bus rejects a
 * stale or unknown id.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

/**
 * @param agentId - BARE agent id of the calling instance (e.g. "baxter",
 *                  "peggy-pool-3"); the bus checks it owns the run.
 */
export function registerJournalTools(server: McpServer, busBaseUrl: string, agentId: string): void {
  server.registerTool(
    'journal_complete',
    {
      description:
        'Finish an AgentBus journal run. Journal runs arrive in an <agentbus-system kind="journal" run_id="…"> block at ' +
        'the start of a turn. Update your memory files first, then call this with that run_id, the files you changed and a ' +
        'one-line note, or nothing_new: true if nothing was worth recording. Until you call it (or the run times out), ' +
        'messages to you are held and your outbound messages are blocked.',
      inputSchema: {
        run_id: z.string().min(1).describe('run_id from the agentbus-system journal block'),
        files_changed: z.array(z.string()).optional().describe('Memory files you created or changed'),
        notes: z.string().optional().describe('One line on what you recorded'),
        nothing_new: z.boolean().optional().describe('True when nothing in the conversation was worth recording'),
      },
    },
    async ({ run_id, files_changed, notes, nothing_new }: { run_id: string; files_changed?: string[]; notes?: string; nothing_new?: boolean }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/journal/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ run_id, agent_id: agentId, files_changed, notes, nothing_new }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (res.status === 404) return toolError(`Unknown journal run: ${run_id}`);
        if (res.status === 403) return toolError(`Journal run ${run_id} belongs to another agent`);
        if (res.status === 409) {
          return toolError(data.error === 'already_completed'
            ? `Journal run ${run_id} is already complete`
            : `Journal run ${run_id} has already ended (timed out or superseded); nothing to complete`);
        }
        if (!res.ok || !data.ok) return toolError(`journal_complete failed: ${data.error ?? `HTTP ${res.status}`}`);
        return toolSuccess({ success: true, run_id });
      } catch (err) {
        return toolError(`Failed to complete journal run: ${String(err)}`);
      }
    },
  );
}
