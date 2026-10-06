/**
 * S7.3 / E8 — Memory Tools: recall_memory, log_memory, search_transcripts
 *
 * The legacy structured store is read-only since E66 (the summarizer that
 * filled it was retired). recall_memory reads it through GET
 * /api/v1/memories/recall and degrades gracefully when the table is missing;
 * log_memory stays registered but always returns an error.
 *
 * search_transcripts is fully functional via FTS5 on transcripts.
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

interface MemoryRecallResponse {
  ok: boolean;
  available?: boolean;
  reason?: string;
  memories?: MemoryResult[];
  count?: number;
  error?: string;
}

interface MemoryResult {
  id: string;
  contact_id: string;
  category: string;
  content: string;
  confidence: number;
  source: string;
  created_at: string;
  expires_at: string | null;
}

export function registerMemoryTools(server: McpServer, busBaseUrl: string): void {
  // ── recall_memory ─────────────────────────────────────────────────────────

  server.registerTool(
    'recall_memory',
    {
      description:
        'Search the memory store for facts about contacts and past conversations. Returns active memories matching the query, ordered by confidence. ' +
        'LEGACY, read-only: the structured store is no longer written (E66). Read your own MEMORY.md and daily journal files instead; this only returns older entries.',
      inputSchema: {
        query: z.string().min(1).describe('Full-text search query'),
        contact_id: z.string().optional().describe('Filter memories for a specific contact'),
        category: z
          .string()
          .optional()
          .describe(
            'Filter by category: preference, fact, plan, relationship, work, health, general',
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .default(10)
          .describe('Max results (default: 10, max: 50)'),
      },
    },
    async ({ query, contact_id, category, limit }) => {
      const params = new URLSearchParams({ q: query });
      if (contact_id !== undefined) params.set('contact_id', contact_id);
      if (category !== undefined) params.set('category', category);
      if (limit !== undefined) params.set('limit', String(limit));

      try {
        const res = await fetch(`${busBaseUrl}/api/v1/memories/recall?${params.toString()}`);
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error?: string;
          };
          return toolError(`Memory recall failed: ${err.error ?? `HTTP ${res.status}`}`);
        }
        const data = (await res.json()) as MemoryRecallResponse;
        if (data.available === false) {
          return toolSuccess({
            available: false,
            reason: data.reason ?? 'Memory system not yet initialized',
            memories: [],
          });
        }
        return toolSuccess({ memories: data.memories ?? [], count: data.count ?? 0 });
      } catch (err) {
        return toolError(`Failed to recall memories: ${String(err)}`);
      }
    },
  );

  // ── log_memory ────────────────────────────────────────────────────────────
  //
  // E66 — the legacy store is read-only. The tool stays registered so an
  // agent prompt that mentions it gets a clear answer instead of "unknown tool".

  server.registerTool(
    'log_memory',
    {
      description:
        'DEPRECATED: the legacy memory store is read-only. Write durable facts to your own memory files (MEMORY.md, ' +
        'daily journal, topic files) instead. Calling this returns an error and records nothing.',
      inputSchema: {
        contact_id: z.string().optional().describe('Ignored'),
        content: z.string().optional().describe('Ignored'),
      },
    },
    async () => toolError(
      'log_memory is no longer available: the legacy memory store is read-only. Write the fact to your memory files instead.',
    ),
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
