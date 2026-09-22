/**
 * Knowledge store tools: write_knowledge, get_knowledge, forget_knowledge, search_knowledge.
 *
 * All four call the bus HTTP API (POST /api/v1/knowledge, GET
 * /api/v1/knowledge/:id, POST /api/v1/knowledge/:id/forget, GET
 * /api/v1/knowledge/search — see src/http/api.ts's "Knowledge store
 * endpoints" section and src/knowledge/store.ts). This is a new, always-on
 * store (Phase 1: FTS5 keyword search, no embeddings yet — see
 * docs/KNOWLEDGE_STORE.md) with no config flag gating it, so unlike
 * recall_memory/log_memory these tools have no `available: false` path —
 * bus-side failures surface as ordinary tool errors.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

interface KnowledgeRow {
  id: string;
  agent_id: string;
  kind: string;
  title: string;
  payload: string;
  index_note: string | null;
  body_text: string;
  tags: string;
  facets: string;
  content_hash: string;
  event_at: string | null;
  valid_from: string | null;
  relevant_until: string | null;
  expires_at: string | null;
  importance: number;
  confidence: number;
  source: string;
  session_id: string | null;
  contact_id: string | null;
  channel: string | null;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
  last_recalled_at: string | null;
  recall_count: number;
}

interface KnowledgeWriteResponse {
  ok: boolean;
  id?: string;
  content_hash?: string;
  superseded_id?: string | null;
  error?: string;
}

interface KnowledgeGetResponse {
  ok: boolean;
  knowledge?: KnowledgeRow;
  error?: string;
}

interface KnowledgeSearchResponse {
  ok: boolean;
  results?: KnowledgeRow[];
  count?: number;
  error?: string;
}

/** Shared error extraction for a non-ok fetch response, matching memory.ts's pattern. */
async function readError(res: Response): Promise<string> {
  const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
  return err.error ?? `HTTP ${res.status}`;
}

export function registerKnowledgeTools(server: McpServer, busBaseUrl: string): void {
  // ── write_knowledge ──────────────────────────────────────────────────────

  server.registerTool(
    'write_knowledge',
    {
      description:
        'Write a structured knowledge row: an arbitrary JSON payload under a kind/schema you choose, ' +
        'searchable later by keyword, kind, tags, facets, or event time. Use this to build up your own ' +
        'durable, queryable record store (e.g. "contact", "project", "decision", "preference") — unlike ' +
        'log_memory, there is no fixed schema and no config flag gating it. Pass `supersedes` when this ' +
        'write replaces an existing row (e.g. an updated fact) so the old one stops showing up in search.',
      inputSchema: {
        agent_id: z.string().min(1).describe('Agent this knowledge belongs to'),
        kind: z.string().min(1).describe('Your own category label, e.g. "contact", "project", "decision"'),
        title: z.string().min(1).describe('Short human-readable title for this row'),
        payload: z
          .string()
          .min(1)
          .describe('The knowledge itself, as a JSON-encoded string in your own schema. Must parse as JSON.'),
        index_note: z.string().optional().describe('Optional short retrieval cue to help future search find this row'),
        tags: z.array(z.string()).optional().describe('Free-form string labels for filtering'),
        facets: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe('Scalar key/value pairs for exact-match filtering, e.g. {"project": "agentbus"}'),
        event_at: z.string().optional().describe('ISO 8601 timestamp of when the described fact/event occurred'),
        valid_from: z.string().optional().describe('ISO 8601 timestamp this row becomes relevant'),
        relevant_until: z.string().optional().describe('ISO 8601 timestamp this row stops being relevant'),
        expires_at: z.string().optional().describe('ISO 8601 hard expiry — excluded from search after this time'),
        importance: z.number().min(0).max(1).optional().describe('0.0-1.0, default 0.5'),
        confidence: z.number().min(0).max(1).optional().describe('0.0-1.0, default 0.9'),
        source: z.string().optional().describe('Where this came from (default "agent")'),
        session_id: z.string().optional().describe('Session this was written from, if any'),
        contact_id: z.string().optional().describe('Contact this knowledge relates to, if any'),
        channel: z.string().optional().describe('Channel this knowledge relates to, if any'),
        supersedes: z.string().optional().describe('Existing knowledge id this write replaces'),
      },
    },
    async (input) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/knowledge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });

        if (!res.ok) {
          return toolError(`Failed to write knowledge: ${await readError(res)}`);
        }

        const data = (await res.json()) as KnowledgeWriteResponse;
        return toolSuccess({
          ok: true,
          id: data.id,
          content_hash: data.content_hash,
          superseded_id: data.superseded_id ?? null,
        });
      } catch (err) {
        return toolError(`Failed to write knowledge: ${String(err)}`);
      }
    },
  );

  // ── get_knowledge ────────────────────────────────────────────────────────

  server.registerTool(
    'get_knowledge',
    {
      description:
        'Fetch one knowledge row by id. Records the recall (bumps recall_count / last_recalled_at) — use ' +
        'this when you already know the id and intend to use the row, not for browsing (use search_knowledge for that).',
      inputSchema: {
        id: z.string().min(1).describe('Knowledge row id'),
      },
    },
    async ({ id }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/knowledge/${encodeURIComponent(id)}`);
        if (res.status === 404) {
          return toolError(`Knowledge row not found: ${id}`);
        }
        if (!res.ok) {
          return toolError(`Failed to fetch knowledge: ${await readError(res)}`);
        }
        const data = (await res.json()) as KnowledgeGetResponse;
        return toolSuccess({ knowledge: data.knowledge });
      } catch (err) {
        return toolError(`Failed to fetch knowledge: ${String(err)}`);
      }
    },
  );

  // ── forget_knowledge ─────────────────────────────────────────────────────

  server.registerTool(
    'forget_knowledge',
    {
      description:
        'Retire a knowledge row. mode "supersede" marks it replaced by another row (pass superseded_by); ' +
        '"expire" sets its expiry to now so it stops showing up in search but the row is kept; "delete" ' +
        'hard-deletes it. Prefer "supersede" or "expire" over "delete" unless the row should be gone entirely.',
      inputSchema: {
        id: z.string().min(1).describe('Knowledge row id to retire'),
        mode: z.enum(['supersede', 'expire', 'delete']).describe('How to retire the row'),
        superseded_by: z
          .string()
          .optional()
          .describe('Required when mode is "supersede" — id of the row that replaces this one'),
      },
    },
    async ({ id, mode, superseded_by }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/knowledge/${encodeURIComponent(id)}/forget`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, superseded_by }),
        });

        if (!res.ok) {
          return toolError(`Failed to forget knowledge: ${await readError(res)}`);
        }

        return toolSuccess({ ok: true });
      } catch (err) {
        return toolError(`Failed to forget knowledge: ${String(err)}`);
      }
    },
  );

  // ── search_knowledge ─────────────────────────────────────────────────────

  server.registerTool(
    'search_knowledge',
    {
      description:
        'Search your knowledge store by keyword (q), kind, tags, facets, and/or event time range. Omit q ' +
        'to just filter/browse, newest-updated first. Excludes superseded and expired rows.',
      inputSchema: {
        agent_id: z.string().min(1).describe('Agent whose knowledge to search'),
        q: z.string().optional().describe('Full-text search query (FTS5 match string)'),
        kind: z.string().optional().describe('Filter to one kind'),
        tags: z.array(z.string()).optional().describe('Row must contain all of these tags'),
        facets: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Row must exact-match every given facet key/value'),
        event_from: z.string().optional().describe('ISO 8601 — only rows with event_at on/after this, or no event_at'),
        event_to: z.string().optional().describe('ISO 8601 — only rows with event_at on/before this, or no event_at'),
        limit: z.number().int().positive().max(50).optional().default(10).describe('Max results (default 10, max 50)'),
      },
    },
    async ({ agent_id, q, kind, tags, facets, event_from, event_to, limit }) => {
      const params = new URLSearchParams({ agent_id });
      if (q !== undefined) params.set('q', q);
      if (kind !== undefined) params.set('kind', kind);
      if (tags !== undefined && tags.length > 0) params.set('tags', tags.join(','));
      if (facets !== undefined) params.set('facets', JSON.stringify(facets));
      if (event_from !== undefined) params.set('event_from', event_from);
      if (event_to !== undefined) params.set('event_to', event_to);
      if (limit !== undefined) params.set('limit', String(limit));

      try {
        const res = await fetch(`${busBaseUrl}/api/v1/knowledge/search?${params.toString()}`);
        if (!res.ok) {
          return toolError(`Knowledge search failed: ${await readError(res)}`);
        }
        const data = (await res.json()) as KnowledgeSearchResponse;
        return toolSuccess({ results: data.results ?? [], count: data.count ?? 0 });
      } catch (err) {
        return toolError(`Failed to search knowledge: ${String(err)}`);
      }
    },
  );
}
