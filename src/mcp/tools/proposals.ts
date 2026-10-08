/**
 * E68 S68.3 — propose_change: the agent proposes a change to one of its
 * protected files (CLAUDE.md, its system prompt file, skills/, .claude/, …)
 * for an owner to approve (POST /api/v1/proposals). The bus applies an
 * approved change itself, if the file hasn't changed since. See
 * docs/AGENT_LEARNING.md#self-edit-proposals.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

/**
 * @param agentId - BARE agent id of the calling instance (a pool pane id is
 *                  mapped to its pool by the bus).
 */
export function registerProposalTools(server: McpServer, busBaseUrl: string, agentId: string): void {
  server.registerTool(
    'propose_change',
    {
      description:
        'Propose a change to one of your protected files (CLAUDE.md, your system prompt file, skills/, .claude/ or others your ' +
        'operator protected). You cannot edit those files yourself; your owners get the proposal as an Approve/Deny request with ' +
        'your rationale and a diff, and the bus applies it if approved and the file has not changed since. Give either the whole ' +
        'new_content or a unified diff against the current file. Memory files are not protected: edit them directly. ' +
        'At most 3 proposals per day; a denied proposal is recorded as feedback, so do not repeat it.',
      inputSchema: {
        path: z.string().min(1).describe('File to change, relative to your working directory (e.g. "CLAUDE.md" or "skills/briefing/SKILL.md")'),
        new_content: z.string().optional().describe('The complete new file content (use this or diff)'),
        diff: z.string().optional().describe('A unified diff against the current file (use this or new_content)'),
        rationale: z.string().min(1).describe('Why the change is needed, in a few sentences, for your owner'),
        evidence: z.array(z.string()).optional().describe('Supporting evidence: dates, conversations, repeated corrections'),
        run_id: z.string().optional().describe('The journal run you are in, if any'),
      },
    },
    async ({ path, new_content, diff, rationale, evidence, run_id }: {
      path: string; new_content?: string; diff?: string; rationale: string; evidence?: string[]; run_id?: string;
    }) => {
      if ((new_content === undefined) === (diff === undefined)) return toolError('Give exactly one of new_content or diff.');
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/proposals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agentId, path, new_content, diff, rationale, evidence, run_id }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean; error?: string; message?: string; id?: string; notified?: number; expires_at?: string; duplicate?: boolean;
        };
        if (!res.ok || !data.ok) return toolError(`Proposal not submitted (${data.error ?? `HTTP ${res.status}`}): ${data.message ?? 'unknown error'}`);
        return toolSuccess({
          success: true,
          proposal_id: data.id,
          status: 'pending',
          notified_owners: data.notified,
          expires_at: data.expires_at,
          ...(data.duplicate ? { note: 'An identical proposal is already waiting for an answer.' } : {}),
        });
      } catch (err) {
        return toolError(`Failed to submit proposal: ${String(err)}`);
      }
    },
  );
}
