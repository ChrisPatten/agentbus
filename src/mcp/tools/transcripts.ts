/**
 * Transcript Tools: search_transcripts (S7.3).
 *
 * Full-text search over conversation transcripts (FTS5). The legacy
 * structured memory tools (recall_memory, log_memory) were removed after E66;
 * agents keep memory in their own files (docs/AGENT_MEMORY.md).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

interface TranscriptSearchResponse {
  ok: boolean;
  available?: boolean;
  reason?: string;
  results?: TranscriptResult[];
}

interface TranscriptResult {
  message_id: string;
  session_id: string;
  channel: string;
  contact_id: string;
  direction: string;
  body: string;
  created_at: string;
}

export function registerTranscriptTools(server: McpServer, busBaseUrl: string): void {
  // ── search_transcripts ────────────────────────────────────────────────────

  server.registerTool(
    'search_transcripts',
    {
      description:
        'Full-text search across conversation transcripts. Returns matching message snippets with session context.',
      inputSchema: {
        query: z.string().min(1).describe('Full-text search query'),
        channel: z.string().optional().describe('Filter by channel (e.g. "telegram")'),
        since: z
          .string()
          .optional()
          .describe('ISO 8601 timestamp — only return messages after this time'),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(10)
          .describe('Max results (default: 10, max: 100)'),
      },
    },
    async ({ query, channel, since, limit }) => {
      const params = new URLSearchParams({ q: query });
      if (channel !== undefined) params.set('channel', channel);
      if (since !== undefined) params.set('since', since);
      if (limit !== undefined) params.set('limit', String(Math.min(limit, 100)));

      try {
        const res = await fetch(`${busBaseUrl}/api/v1/transcripts/search?${params.toString()}`);
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error?: string;
          };
          return toolError(`Transcript search failed: ${err.error ?? `HTTP ${res.status}`}`);
        }
        const data = (await res.json()) as TranscriptSearchResponse;
        if (data.available === false) {
          return toolSuccess({
            available: false,
            reason: data.reason ?? 'Transcript search not available',
          });
        }
        return toolSuccess({ results: data.results ?? [], count: (data.results ?? []).length });
      } catch (err) {
        return toolError(`Failed to search transcripts: ${String(err)}`);
      }
    },
  );
}
