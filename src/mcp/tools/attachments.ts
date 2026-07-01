/**
 * E22 — Attachment tool: fetch_attachment
 *
 * Resolves a stored attachment by id to its on-disk path. Primarily used to
 * pull in inline (HTML-embedded) email images that are intentionally kept out
 * of the agent's message context — the agent receives only the attachment id in
 * a `[Inline image available …]` hint and calls this tool when it decides the
 * image matters. The lookup (including TTL/expiry) lives in the bus-core
 * endpoint GET /api/v1/attachments/:id.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

interface AttachmentResponse {
  ok: boolean;
  attachment?: {
    id: string;
    local_path: string;
    mime_type: string | null;
    original_filename: string | null;
  };
  error?: string;
}

export function registerAttachmentTools(server: McpServer, busBaseUrl: string): void {
  server.registerTool(
    'fetch_attachment',
    {
      description:
        'Resolve a stored attachment id to its local file path so you can read it. ' +
        'Use this to pull in an inline email image referenced by a ' +
        '"[Inline image available — fetch with fetch_attachment(id=...)]" hint. ' +
        'Returns a not-found error if the attachment has expired or does not exist.',
      inputSchema: {
        id: z.string().min(1).describe('Attachment id from the inline-image hint'),
      },
    },
    async ({ id }: { id: string }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/attachments/${encodeURIComponent(id)}`);
        const data = (await res.json().catch(() => ({}))) as AttachmentResponse;

        if (res.status === 404) {
          return toolError(`Attachment not found or expired: ${id}`);
        }
        if (!res.ok || !data.attachment) {
          return toolError(`Failed to fetch attachment: HTTP ${res.status}`);
        }

        return toolSuccess(data.attachment);
      } catch (err) {
        return toolError(`Failed to fetch attachment: ${String(err)}`);
      }
    },
  );
}
