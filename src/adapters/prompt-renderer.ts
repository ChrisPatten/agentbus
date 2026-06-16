/**
 * System prompt template renderer for the cc-headless adapter.
 *
 * Replaces {{variable}} placeholders in a template string. Unknown placeholders
 * are left as-is so partial templates fail visibly rather than silently.
 */
import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

export interface PromptContext {
  contact_id: string;
  channel: string;
  date: string;
  memories: string;
  session_summary: string;
  agent_id: string;
}

export function renderSystemPrompt(template: string, ctx: PromptContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in ctx ? ctx[key as keyof PromptContext] : match;
  });
}

/**
 * Expand `@path` references in an operator-authored system prompt, mirroring
 * Claude Code's @-file inclusion. Each `@<path>` token is replaced with the
 * referenced file's contents, resolved relative to `baseDir`. Tokens that don't
 * resolve to a readable file are left verbatim (like unknown {{vars}}), so a
 * typo is visible rather than silently dropped.
 *
 * Only ever call this on TRUSTED config text (the system_prompt template), never
 * on inbound user messages — expanding user-supplied @paths would allow reading
 * arbitrary files off disk.
 *
 * A path may be wrapped in backticks (`@`path``) or bare. Recognized chars:
 * letters, digits, and . _ - / so the match stops at whitespace/punctuation.
 */
export function expandFileReferences(template: string, baseDir: string): string {
  return template.replace(/(^|\s)@([\w./_-]+)/g, (match, lead: string, path: string) => {
    const abs = isAbsolute(path) ? path : resolve(baseDir, path);
    try {
      const content = readFileSync(abs, 'utf-8');
      return `${lead}${content}`;
    } catch {
      // Unreadable / missing — leave the reference untouched so it's visible.
      return match;
    }
  });
}
