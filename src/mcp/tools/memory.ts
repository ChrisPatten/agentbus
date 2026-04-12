/**
 * S7.3 — Memory Tools: recall_memory, log_memory, search_transcripts
 *
 * recall_memory and log_memory are stubs until E8/E9 implements the memories
 * table. search_transcripts is fully functional via FTS5 on transcripts.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

const MEMORY_UNAVAILABLE = {
  available: false,
  reason: 'Memory system not yet initialized',
} as const;

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

export function registerMemoryTools(server: McpServer, busBaseUrl: string): void {
  // ── recall_memory ─────────────────────────────────────────────────────────

  server.registerTool(
    'recall_memory',
    {
      description:
        'Search the memory store for facts about contacts and past conversations. Returns empty until E8/E9 memory system is initialized.',
      inputSchema: {
        query: z.string().min(1).describe('Search query'),
        contact_id: z.string().optional().describe('Filter memories for a specific contact'),
        limit: z.number().int().positive().optional().default(10).describe('Max results (default: 10)'),
      },
    },
    () => {
      return toolSuccess(MEMORY_UNAVAILABLE);
    }
  );

  // ── log_memory ────────────────────────────────────────────────────────────

  server.registerTool(
    'log_memory',
    {
      description:
        'Explicitly record a fact to the memory store. Returns unavailable until E8/E9 memory system is initialized.',
      inputSchema: {
        contact_id: z.string().min(1).describe('Contact this memory is about'),
        content: z.string().min(1).describe('The fact or memory to record'),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .default(0.9)
          .describe('Confidence score 0.0–1.0 (default: 0.9)'),
        source: z.string().optional().default('manual').describe('Source of the memory (default: manual)'),
      },
    },
    () => {
      return toolSuccess(MEMORY_UNAVAILABLE);
    }
  );

  // ── search_transcripts ────────────────────────────────────────────────────

  server.registerTool(
    'search_transcripts',
    {
      description:
        'Full-text search across conversation transcripts. Returns matching message snippets with session context.',
      inputSchema: {
        query: z.string().min(1).describe('Full-text search query'),
        channel: z.string().optional().describe('Filter by channel (e.g. "telegram")'),
        since: z.string().optional().describe('ISO 8601 timestamp — only return messages after this time'),
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
          return toolSuccess({ available: false, reason: data.reason ?? 'Transcript search not available' });
        }
        return toolSuccess({ results: data.results ?? [], count: (data.results ?? []).length });
      } catch (err) {
        return toolError(`Failed to search transcripts: ${String(err)}`);
      }
    }
  );
}
