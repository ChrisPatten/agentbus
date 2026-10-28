/**
 * E79 — `status` tool: the agent writes its own live status line.
 *
 * The tool itself only validates and sanitises the text. The line reaches
 * the user because the layer that already watches the turn's tool calls
 * (cc-headless's stream parser, or the pool's tool-status hook) sees this
 * call, applies the same sanitiser, and posts the text to the turn's
 * (channel, contact) pairs through the existing tool-status endpoint. That
 * layer also makes the text sticky for the rest of the turn and never emits
 * a line for the `status` call itself.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';
import { sanitizeStatusText, STATUS_MAX_CHARS, STATUS_MAX_WORDS } from '../../adapters/tool-status.js';

export function registerStatusTool(server: McpServer): void {
  server.registerTool(
    'status',
    {
      description:
        `Set the short live status line the user sees while you work on their message, e.g. "Checking the calendar" or "Comparing the two quotes". ` +
        `2-${STATUS_MAX_WORDS} plain words, at most ${STATUS_MAX_CHARS} characters, no file paths, message text or other content. ` +
        'It replaces the automatic status and holds until your next `status` call or the end of the turn. ' +
        'Optional: automatic status lines are shown if you never call this. It does nothing once you have delivered your reply.',
      inputSchema: {
        text: z.string().max(200).describe(`Status text, 2-${STATUS_MAX_WORDS} words, at most ${STATUS_MAX_CHARS} characters`),
      },
    },
    async ({ text }: { text: string }) => {
      const clean = sanitizeStatusText(text);
      if (!clean) {
        return toolError(
          `Invalid status: use 1-${STATUS_MAX_WORDS} plain words, at most ${STATUS_MAX_CHARS} characters (letters, digits and basic punctuation only).`,
        );
      }
      return toolSuccess({ success: true, status: clean });
    },
  );
}
