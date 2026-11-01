/**
 * E90 (I3) — glance lines and plain-text bodies for Intercom surfaces.
 *
 * A glance is a one-line summary (at most {@link GLANCE_MAX} characters) the
 * agent may pass on `reply` / `send_message`. When it does not, the bus
 * derives one. Pure functions, no dependencies: the MCP tools import them too.
 */

export const GLANCE_MAX = 100;
export const REPLY_BODY_MAX = 1200;

/** Markdown to plain text. Keeps line breaks and turns list markers into `•`. */
export function stripMarkdown(input: string): string {
  let text = input.replace(/\r\n?/g, '\n');
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1');            // fenced code: keep the code
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');               // images
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');                // links
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');                     // headings
  text = text.replace(/^\s{0,3}>\s?/gm, '');                          // quotes
  text = text.replace(/^(\s*)[-*+]\s+/gm, '$1• ');                    // bullets
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');                     // bold
  text = text.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=$|[\s).,;:!?])/g, '$1$2'); // italics
  text = text.replace(/~~(.+?)~~/g, '$1');                            // strike
  text = text.replace(/`([^`\n]+)`/g, '$1');                          // inline code
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');                 // rules
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** Cut `text` to `max` characters at a word boundary, ending in an ellipsis when cut. */
export function truncateAtWord(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const room = Math.max(1, max - 1);
  let cut = chars.slice(0, room).join('');
  const lastSpace = cut.search(/\s\S*$/);
  if (lastSpace > room * 0.4) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/[\s,;:.\-–—]+$/u, '')}…`;
}

/** An agent-supplied glance: whitespace collapsed, markdown stripped, cut to {@link GLANCE_MAX}. Null when empty or not a string. */
export function clampGlance(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const flat = stripMarkdown(value).replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return Array.from(flat).length > GLANCE_MAX ? truncateAtWord(flat, GLANCE_MAX) : flat;
}

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'st', 'jr', 'sr', 'vs', 'etc', 'eg', 'ie', 'no', 'inc', 'co', 'a.m', 'p.m', 'am', 'pm']);

/** The text up to the first sentence end, skipping abbreviations such as "Mr." and initials. */
function firstSentence(line: string): string {
  const end = /[.!?]+(?=\s|$)/gu;
  for (let m = end.exec(line); m; m = end.exec(line)) {
    const before = line.slice(0, m.index);
    const word = /(\S+)$/u.exec(before)?.[1]?.toLowerCase().replace(/^[("'“]+/, '') ?? '';
    if (m[0] === '.' && (ABBREVIATIONS.has(word) || /^[a-z]$/.test(word))) continue;
    return line.slice(0, m.index + m[0].length);
  }
  return line;
}

/** The first sentence of `body` with markdown stripped, cut to {@link GLANCE_MAX} on a word boundary. */
export function deriveGlance(body: string): string {
  const plain = stripMarkdown(body);
  const firstLine = plain.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const sentence = firstSentence(firstLine);
  const flat = sentence.replace(/\s+/g, ' ').trim();
  return Array.from(flat).length > GLANCE_MAX ? truncateAtWord(flat, GLANCE_MAX) : flat;
}

/** The glance to store: the agent's own when usable, otherwise derived from the body. */
export function resolveGlance(value: unknown, body: string): string {
  return clampGlance(value) ?? deriveGlance(body);
}

/** Plain-text reply body for a surface, cut to {@link REPLY_BODY_MAX}. `cut` is true when text was dropped. */
export function surfaceBody(body: string): { text: string; cut: boolean } {
  const plain = stripMarkdown(body);
  if (Array.from(plain).length <= REPLY_BODY_MAX) return { text: plain, cut: false };
  return { text: truncateAtWord(plain, REPLY_BODY_MAX), cut: true };
}
