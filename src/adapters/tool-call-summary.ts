/**
 * Tool-call summary formatting (E29).
 *
 * Turns a raw `tool_use` block (name + input) from `claude -p`'s stream-json
 * event stream into a short, human-readable status line for the Telegram
 * live tool-call status stream. Pure and side-effect-free — colocated with
 * cc-headless.ts (the callback consumer) but standalone for isolated testing.
 */

/** Maximum length of an interpolated field (file_path/url/pattern/query).
 * Keeps a single absurdly long value from blowing the draft message's length
 * budget on its own — TelegramAdapter's truncation only ever drops whole
 * lines, so this keeps that guarantee meaningful in practice. */
const MAX_FIELD_LENGTH = 200;

function truncateField(value: string): string {
  return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}…` : value;
}

/** Neutralizes backticks in a value about to be wrapped in a code span — an
 * unescaped backtick would terminate the span early and reintroduce the
 * Markdown-breakage this module exists to avoid (E34). Not a general
 * Markdown escaper: this is the only character that can break a code span. */
function escapeForCodeSpan(value: string): string {
  return value.replaceAll('`', '´');
}

function genericFallback(name: string): string {
  return name ? `⚙️ Running \`${name}\`` : `⚙️ Running tool`;
}

/**
 * Reads `input[field]` as a non-empty string and renders it via `render`, or
 * falls back to the generic line for `name`. Used both for unknown tool
 * names and for a covered tool whose required field is missing/malformed —
 * both cases render the identical generic fallback string.
 *
 * The value handed to `render` is truncated and backtick-escaped, but not
 * wrapped in backticks itself — each `render` callback wraps its own value in
 * a code span (leaving the emoji/verb prefix as plain Markdown prose) because
 * Telegram's Markdown dialect treats a bare `_` as an emphasis delimiter, and
 * these dynamic values (paths, URLs, patterns, tool names) routinely contain
 * one (E34).
 */
function withField(
  input: Record<string, unknown>,
  field: string,
  name: string,
  render: (value: string) => string,
): string {
  const value = input[field];
  if (typeof value !== 'string' || value.trim() === '') return genericFallback(name);
  return render(escapeForCodeSpan(truncateField(value)));
}

/**
 * Formats a tool call as a short status line. Never throws, never returns an
 * empty string — an unrecognized tool name, or a recognized one missing its
 * expected field, both degrade to the generic "Running {name}" fallback.
 */
export function formatToolCallSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return withField(input, 'description', name, (d) => `🐚 \`${d}\``);
    case 'Agent':
      return withField(input, 'description', name, (d) => `🤖 \`${d}\``);
    case 'Read':
      return withField(input, 'file_path', name, (p) => `📖 Reading \`${p}\``);
    case 'Edit':
      return withField(input, 'file_path', name, (p) => `✏️ Editing \`${p}\``);
    case 'Write':
      return withField(input, 'file_path', name, (p) => `📝 Writing \`${p}\``);
    case 'Grep':
      return withField(input, 'pattern', name, (p) => `🔍 Searching for \`${p}\``);
    case 'WebFetch':
      return withField(input, 'url', name, (u) => `🌐 Fetching \`${u}\``);
    case 'WebSearch':
      return withField(input, 'query', name, (q) => `🔎 Searching: \`${q}\``);
    default:
      return genericFallback(name);
  }
}
