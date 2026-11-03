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
 *
 * E96: the optional `subject` travels the same way (as `subject` on the
 * tool-status POST); the bus stores it per conversation for the surface
 * sessions resource.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';
import { sanitizeStatusText, sanitizeSubject, STATUS_MAX_CHARS, STATUS_MAX_WORDS, SUBJECT_MAX_CHARS } from '../../adapters/tool-status.js';

export function registerStatusTool(server: McpServer): void {
  server.registerTool(
    'status',
    {
      description:
        `Set the short live status line the user sees while you work on their message, e.g. "Checking the calendar" or "Comparing the two quotes". ` +
        `2-${STATUS_MAX_WORDS} plain words, at most ${STATUS_MAX_CHARS} characters, no file paths, message text or other content. ` +
        'It replaces the automatic status and holds until your next `status` call or the end of the turn. ' +
        'Optional: automatic status lines are shown if you never call this. It does nothing once you have delivered your reply. ' +
        `Optionally pass \`subject\`: what this whole session is about (e.g. "Kitchen quote comparison", at most ${SUBJECT_MAX_CHARS} characters); ` +
        'it labels the session on Intercom until you set a new one, and is kept even after your reply.',
      inputSchema: {
        text: z.string().max(200).describe(`Status text, 2-${STATUS_MAX_WORDS} words, at most ${STATUS_MAX_CHARS} characters`),
        subject: z.string().max(200).optional().describe(`What this session is about, plain words, at most ${SUBJECT_MAX_CHARS} characters`),
      },
    },
    async ({ text, subject }: { text: string; subject?: string | undefined }) => {
      const clean = sanitizeStatusText(text);
      if (!clean) {
        return toolError(
          `Invalid status: use 1-${STATUS_MAX_WORDS} plain words, at most ${STATUS_MAX_CHARS} characters (letters, digits and basic punctuation only).`,
        );
      }
      if (subject === undefined) return toolSuccess({ success: true, status: clean });
      const cleanSubject = sanitizeSubject(subject);
      if (!cleanSubject) {
        return toolError(`Invalid subject: use plain words, at most ${SUBJECT_MAX_CHARS} characters (letters, digits and basic punctuation only).`);
      }
      return toolSuccess({ success: true, status: clean, subject: cleanSubject });
    },
  );
}
