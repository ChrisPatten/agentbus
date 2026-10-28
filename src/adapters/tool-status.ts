/**
 * E79 — succinct status lines for the live tool-call status stream.
 *
 * Replaces the raw tool-call lines of E29 (`tool-call-summary.ts`) with fixed
 * 2-5 word phrases looked up from `scripts/hooks/tool-status-phrases.json`,
 * the same data file `scripts/hooks/agentbus_tool_status_hook.sh` reads with
 * jq, so the pool hook and cc-headless say the same thing. Pure apart from
 * the one-time file read. A phrase NEVER contains tool input: the lookup uses
 * the tool name and (for Bash only) the command's first word to choose among
 * fixed strings, and nothing from the input is ever copied into the output.
 *
 * Also owns the `status` MCP tool's name, text sanitiser, and the per-turn
 * tracker that keeps an agent-authored status from being overwritten by a
 * fixed phrase for the rest of the turn.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatToolCallSummary } from './tool-call-summary.js';

export const STATUS_TOOL_NAME = 'mcp__agentbus__status';
export const STATUS_MAX_CHARS = 40;
export const STATUS_MAX_WORDS = 5;

/** Built-in fallback when no phrases file can be read. */
const FALLBACK = 'Working on it';

export interface PhrasesFile {
  default?: string;
  tools?: Record<string, string>;
  bash?: Array<{ commands: string[]; text: string }>;
  prefixes?: Array<{ prefix: string; default?: string; tools?: Record<string, string> }>;
}

export const DEFAULT_PHRASES_PATH = fileURLToPath(
  new URL('../../scripts/hooks/tool-status-phrases.json', import.meta.url),
);

/** Reads a phrases file; any failure yields an empty table (every lookup then falls back to "Working on it"). */
export function loadPhrases(path: string = DEFAULT_PHRASES_PATH): PhrasesFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as PhrasesFile) : {};
  } catch (err) {
    console.warn(`[tool-status] could not read phrases file ${path}: ${String(err)}`);
    return {};
  }
}

/**
 * Same shape as the jq regex in the hook: optional `cd x &&`, `rtk [proxy]`,
 * `VAR=val` prefixes, an optional path before the command, then the command
 * as a whole word.
 */
function bashRegex(commands: string[]): RegExp {
  const names = commands.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(
    `^(cd\\s+\\S+\\s*(&&|;)\\s*)?(rtk\\s+(proxy\\s+)?)?(\\S+=\\S+\\s+)*(\\S*/)?(${names})(\\s|$)`,
  );
}

function clamp(phrase: string): string {
  return phrase.length > STATUS_MAX_CHARS ? phrase.slice(0, STATUS_MAX_CHARS).trim() : phrase;
}

/**
 * The fixed phrase for a tool call. Never throws, never returns an empty
 * string, never includes anything from `input`.
 */
export function phraseForToolCall(name: string, input: Record<string, unknown>, table: PhrasesFile): string {
  const fallback = table.default?.trim() || FALLBACK;
  if (name === 'Bash' && table.bash) {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    for (const entry of table.bash) {
      if (entry.commands?.length && entry.text && bashRegex(entry.commands).test(command)) return clamp(entry.text);
    }
  }
  const exact = table.tools?.[name];
  if (exact) return clamp(exact);
  for (const p of table.prefixes ?? []) {
    if (!p.prefix || !name.startsWith(p.prefix)) continue;
    const phrase = p.tools?.[name.slice(p.prefix.length)] ?? p.default;
    if (phrase) return clamp(phrase);
  }
  return clamp(fallback);
}

/**
 * Sanitises agent-authored status text. Anything outside letters, digits,
 * space and a few plain punctuation marks (which also removes Markdown
 * syntax and control characters) becomes a space; whitespace is collapsed
 * and trimmed. Returns the cleaned text, or null when it is empty, longer
 * than {@link STATUS_MAX_CHARS} characters or more than {@link STATUS_MAX_WORDS}
 * words after cleaning. The jq pipeline in the hook applies the same rules.
 */
export function sanitizeStatusText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .replace(/[^\p{L}\p{N} '’,.&/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > STATUS_MAX_CHARS) return null;
  if (cleaned.split(' ').length > STATUS_MAX_WORDS) return null;
  return cleaned;
}

export type ToolStatusMode = 'phrases' | 'raw';

export interface ToolStatusLine {
  text: string;
  /** Phrase-mode lines replace the previous one instead of piling up (sent as `placeholder: true`). */
  transient: boolean;
}

/**
 * One turn's status state. Feed it each non-delivery tool call in order; it
 * returns the line to post, or undefined when nothing should be posted.
 *
 * Stickiness: once the agent calls `status` with valid text, fixed phrases
 * are suppressed for the rest of this turn (turn-long, no timer), until the
 * agent calls `status` again. A fresh tracker is made per turn.
 */
export class TurnStatusTracker {
  private agentAuthored = false;
  private last: string | undefined;

  constructor(
    private readonly mode: ToolStatusMode,
    private readonly table: PhrasesFile,
  ) {}

  next(call: { name: string; input: Record<string, unknown> }): ToolStatusLine | undefined {
    if (call.name === STATUS_TOOL_NAME) {
      if (this.mode === 'raw') return undefined;
      const text = sanitizeStatusText(call.input['text']);
      if (!text) return undefined;
      this.agentAuthored = true;
      return this.emit(text);
    }
    if (this.mode === 'raw') return { text: formatToolCallSummary(call.name, call.input), transient: false };
    if (this.agentAuthored) return undefined;
    return this.emit(phraseForToolCall(call.name, call.input, this.table));
  }

  private emit(text: string): ToolStatusLine | undefined {
    if (text === this.last) return undefined;
    this.last = text;
    return { text, transient: true };
  }
}
