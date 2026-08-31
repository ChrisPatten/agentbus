/**
 * S7.4 — Session Tools: get_session, list_sessions
 *
 * Provides access to session metadata and summaries stored in bus-core.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

interface SessionSummary {
  summary: string | null;
  model: string | null;
  token_count: number | null;
  created_at: string | null;
}

interface Session {
  id: string;
  conversation_id: string | null;
  channel: string;
  contact_id: string | null;
  started_at: string;
  last_activity: string;
  ended_at: string | null;
  message_count: number;
  summary: SessionSummary | null;
  /** Conversation topic (e.g. "general" or "thread:<hash>"), via conversation_registry (E32). */
  topic: string | null;
}

interface SessionResponse {
  ok: boolean;
  session: Session;
}

interface SessionsResponse {
  ok: boolean;
  sessions: Session[];
}

interface TranscriptRow {
  message_id: string;
  session_id: string;
  channel: string;
  contact_id: string;
  direction: string;
  body: string;
  created_at: string;
}

interface TranscriptResponse {
  ok: boolean;
  transcript: TranscriptRow[];
  count: number;
}

export function registerSessionTools(server: McpServer, busBaseUrl: string): void {
  // ── get_session ───────────────────────────────────────────────────────────

  server.registerTool(
    'get_session',
    {
      description:
        'Get details for a specific session, or the most recent session if no ID is provided. ' +
        'Returns session metadata plus any available summary.',
      inputSchema: {
        session_id: z.string().optional().describe('Session ID to fetch. Omit to get the most recent session.'),
      },
    },
    async ({ session_id }) => {
      try {
        let res: Response;
        if (session_id !== undefined) {
          res = await fetch(`${busBaseUrl}/api/v1/sessions/${session_id}`);
          if (res.status === 404) {
            return toolSuccess({ available: false, reason: `Session not found: ${session_id}` });
          }
        } else {
          // Bus returns sessions ORDER BY started_at DESC; limit=1 gives the most recent.
          res = await fetch(`${busBaseUrl}/api/v1/sessions?limit=1`);
          if (res.ok) {
            const data = (await res.json()) as SessionsResponse;
            if (data.sessions.length === 0) {
              return toolSuccess({ available: false, reason: 'No sessions found' });
            }
            const session = data.sessions[0]!;
            return toolSuccess({ session_id: session.id, ...session });
          }
        }

        if (!res.ok) {
          return toolError(`Failed to fetch session: HTTP ${res.status}`);
        }

        const data = (await res.json()) as SessionResponse;
        return toolSuccess({ session_id: data.session.id, ...data.session });
      } catch (err) {
        return toolError(`Failed to get session: ${String(err)}`);
      }
    }
  );

  // ── list_sessions ─────────────────────────────────────────────────────────

  server.registerTool(
    'list_sessions',
    {
      description:
        'List recent sessions with their summaries. Supports filtering by channel or contact.',
      inputSchema: {
        channel: z.string().optional().describe('Filter by channel (e.g. "telegram")'),
        contact_id: z.string().optional().describe('Filter by contact ID (e.g. "contact:chris")'),
        since: z.string().optional().describe('ISO 8601 timestamp — only sessions started after this time'),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(20)
          .describe('Max sessions to return (default: 20, max: 100)'),
      },
    },
    async ({ channel, contact_id, since, limit }) => {
      const params = new URLSearchParams();
      if (channel !== undefined) params.set('channel', channel);
      if (contact_id !== undefined) params.set('contact_id', contact_id);
      if (since !== undefined) params.set('since', since);
      if (limit !== undefined) params.set('limit', String(Math.min(limit, 100)));

      try {
        const qs = params.toString();
        const res = await fetch(`${busBaseUrl}/api/v1/sessions${qs ? `?${qs}` : ''}`);
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error?: string;
          };
          return toolError(`Failed to list sessions: ${err.error ?? `HTTP ${res.status}`}`);
        }
        const data = (await res.json()) as SessionsResponse;
        return toolSuccess({ sessions: data.sessions, count: data.sessions.length });
      } catch (err) {
        return toolError(`Failed to list sessions: ${String(err)}`);
      }
    }
  );

  // ── get_transcript ────────────────────────────────────────────────────────

  server.registerTool(
    'get_transcript',
    {
      description:
        'Get the full, ordered message-by-message transcript for a specific session — every ' +
        'inbound and outbound message, oldest first. Use this to pull real conversation context ' +
        'for a session surfaced by list_sessions or referenced in a memory file. Complements ' +
        'search_transcripts (keyword-driven, cross-session snippets, no surrounding context) and ' +
        'get_session (metadata + summary only, no message content).',
      inputSchema: {
        session_id: z.string().describe('Session ID to fetch the transcript for'),
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .default(200)
          .describe('Max messages to return (default: 200, max: 1000)'),
        since: z.string().optional().describe('ISO 8601 timestamp — only messages after this time'),
        before: z.string().optional().describe('ISO 8601 timestamp — only messages before this time'),
      },
    },
    async ({ session_id, limit, since, before }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(Math.min(limit, 1000)));
      if (since !== undefined) params.set('since', since);
      if (before !== undefined) params.set('before', before);

      try {
        const qs = params.toString();
        const res = await fetch(`${busBaseUrl}/api/v1/sessions/${session_id}/transcript${qs ? `?${qs}` : ''}`);
        if (res.status === 404) {
          return toolSuccess({ available: false, reason: `Session not found: ${session_id}` });
        }
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error?: string;
          };
          return toolError(`Failed to fetch transcript: ${err.error ?? `HTTP ${res.status}`}`);
        }
        const data = (await res.json()) as TranscriptResponse;
        return toolSuccess({ transcript: data.transcript, count: data.count });
      } catch (err) {
        return toolError(`Failed to get transcript: ${String(err)}`);
      }
    }
  );
}
