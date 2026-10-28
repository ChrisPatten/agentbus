/**
 * Bus-originated system blocks (E65 S65.3).
 *
 * A system block is text the bus itself adds to an agent's turn, as opposed
 * to text a person sent. Advisories (E65) use it today; the System Message
 * journaler (E66) reuses it for journaling instructions.
 *
 * Format, always at the very start of the turn, before any message:
 *
 *   <agentbus-system kind="advisories">
 *   ...bus text...
 *   </agentbus-system>
 *
 * Spoofing resistance has three parts:
 *   1. Inbound text can't contain the marker. `neutralizeSystemMarkers()`
 *      rewrites anything that looks like an opening or closing
 *      `agentbus-system` tag (case, whitespace, zero-width characters,
 *      look-alike brackets and dashes) in message bodies, quotes, file
 *      names and injected context before they are rendered.
 *   2. Callers can't set the metadata that carries blocks. Every ingress
 *      point (`processInbound`, `POST /api/v1/messages`) drops the reserved
 *      keys with `stripSystemMetadata()`; only in-process bus code adds them
 *      after that.
 *   3. Blocks are rendered first, so a real block is never preceded by a
 *      "New message from" line. Agent CLAUDE.md files should trust a block
 *      only in that position (see docs/ADVISORIES.md).
 *
 * This module is pure (no config, no DB) so the separate cc.ts MCP process
 * can render with it too.
 */

export const SYSTEM_BLOCK_TAG = 'agentbus-system';

/** Envelope metadata key holding system blocks for the recipient. Reserved: stripped at ingress. */
export const SYSTEM_BLOCKS_KEY = 'system_blocks';
/**
 * Envelope metadata flag marking a bus-originated turn with no human
 * message: the envelope's body is not shown to the agent, only its blocks.
 * Reserved: stripped at ingress.
 */
export const SYSTEM_ONLY_KEY = 'system_only';

/**
 * E66 — envelope metadata key naming the System Message journal run an
 * instruction belongs to. The journal hold lets only that envelope through.
 * Reserved: stripped at ingress.
 */
export const JOURNAL_RUN_KEY = 'journal_run_id';

/**
 * E82 — transcript metadata flag marking a hidden handoff (`share_context`):
 * Main reads the row as context, the app never shows it. Reserved: stripped
 * at ingress, so only `POST /api/v1/context` can set it.
 */
export const CONTEXT_ONLY_KEY = 'context_only';

/**
 * E83 — envelope metadata key carrying a pending-context block for a cc-pool
 * pane (see `PendingContextAttachment`). Unlike a system block it is quoted
 * text from other sessions, rendered outside `<agentbus-system>`. Reserved:
 * stripped at ingress, so a caller can never inject one.
 */
export const PENDING_CONTEXT_KEY = 'pending_context';

const RESERVED_KEYS = [SYSTEM_BLOCKS_KEY, SYSTEM_ONLY_KEY, JOURNAL_RUN_KEY, CONTEXT_ONLY_KEY, PENDING_CONTEXT_KEY] as const;

/**
 * A block attached during the pipeline. `recipient`, when set, limits it to
 * the fan-out copy for that route target (e.g. one agent of several); the
 * fan-out step drops the field and stores plain strings.
 */
export interface PendingSystemBlock {
  text: string;
  recipient?: string;
}

// Anything between "<" and the tag name that a reader might skip over.
const GAP = '[\\s\\u200B-\\u200D\\u2060\\uFEFF]*';
// "<", fullwidth "＜", small "﹤", and angle brackets "‹" "〈" "⟨".
const OPEN_BRACKET = '[<\\uFF1C\\uFE64\\u2039\\u3008\\u27E8]';
// "/" plus its fullwidth and division-slash look-alikes.
const SLASH = '[/\\uFF0F\\u2215]';
// "-", "_", and the Unicode dashes and hyphens.
const DASH = '[-_\\u2010-\\u2015\\u2212\\uFE63\\uFF0D]';
const MARKER_RE = new RegExp(
  `${OPEN_BRACKET}${GAP}(${SLASH}?)${GAP}agentbus${GAP}${DASH}?${GAP}system`,
  'giu',
);

/**
 * Rewrite anything in `text` that could be read as an opening or closing
 * system-block tag. Text without one is returned unchanged.
 */
export function neutralizeSystemMarkers(text: string): string {
  return text.replace(MARKER_RE, (_m, slash: string) =>
    `[removed ${slash ? 'closing ' : ''}${SYSTEM_BLOCK_TAG} marker]`);
}

/** True when `text` contains something `neutralizeSystemMarkers` would rewrite. */
export function containsSystemMarker(text: string): boolean {
  MARKER_RE.lastIndex = 0;
  const found = MARKER_RE.test(text);
  MARKER_RE.lastIndex = 0;
  return found;
}

const escapeAttr = (v: string) => v.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!);

/**
 * Render one system block. `kind` names the producer ("advisories",
 * "journal"); `attrs` adds more attributes. The body is bus-authored but
 * may quote other text (file names, errors), so it is neutralized too: a
 * body can never close the block early.
 */
export function renderSystemBlock(kind: string, body: string, attrs: Record<string, string> = {}): string {
  const attrText = Object.entries({ kind, ...attrs })
    .filter(([k]) => /^[a-z][a-z0-9_-]*$/i.test(k))
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  return `<${SYSTEM_BLOCK_TAG}${attrText}>\n${neutralizeSystemMarkers(body.trim())}\n</${SYSTEM_BLOCK_TAG}>`;
}

/** Remove the reserved keys from caller-supplied metadata. Returns a new object. */
export function stripSystemMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(metadata ?? {}) };
  for (const key of RESERVED_KEYS) delete out[key];
  return out;
}

/** Attach a block during the pipeline, optionally for one route recipient only. */
export function attachSystemBlock(metadata: Record<string, unknown>, text: string, recipient?: string): void {
  const existing = Array.isArray(metadata[SYSTEM_BLOCKS_KEY]) ? (metadata[SYSTEM_BLOCKS_KEY] as unknown[]) : [];
  const entry: PendingSystemBlock = recipient ? { text, recipient } : { text };
  metadata[SYSTEM_BLOCKS_KEY] = [...existing, entry];
}

/**
 * The blocks a fan-out copy for `recipient` should carry, as plain strings.
 * Entries without a recipient go to every copy.
 */
export function systemBlocksFor(metadata: Record<string, unknown> | undefined, recipient: string): string[] {
  const raw = metadata?.[SYSTEM_BLOCKS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry && typeof entry === 'object' && typeof (entry as PendingSystemBlock).text === 'string') {
      const { text, recipient: only } = entry as PendingSystemBlock;
      if (!only || only === recipient) out.push(text);
    }
  }
  return out;
}

/** Blocks carried by a queued envelope, for rendering. */
export function readSystemBlocks(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.[SYSTEM_BLOCKS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === 'string' ? entry : (entry as PendingSystemBlock | null)?.text))
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
}

/**
 * E83 — what the pending-context stage attaches to a pane's copy of a message:
 * the rendered block (null when every pending item had expired, so there is
 * nothing to show) and the watermark to advance to once the pane acks it. The
 * block is built against the watermark as it stood, so messages polled
 * together carry the same one.
 */
export interface PendingContextAttachment {
  conversation_id: string;
  block: string | null;
  through: { created_at: string; id: string };
}

/** Pipeline-time form: attachments tagged with the route recipient they are for. */
type PendingContextEntry = PendingContextAttachment & { recipient: string };

/** Attach pending context during the pipeline, for one route recipient. */
export function attachPendingContext(metadata: Record<string, unknown>, recipient: string, attachment: PendingContextAttachment): void {
  const existing = Array.isArray(metadata[PENDING_CONTEXT_KEY]) ? (metadata[PENDING_CONTEXT_KEY] as PendingContextEntry[]) : [];
  metadata[PENDING_CONTEXT_KEY] = [...existing.filter((e) => e.recipient !== recipient), { ...attachment, recipient }];
}

/** The attachment a fan-out copy for `recipient` should carry (pipeline-time form), or null. */
export function pendingContextFor(metadata: Record<string, unknown> | undefined, recipient: string): PendingContextAttachment | null {
  const raw = metadata?.[PENDING_CONTEXT_KEY];
  if (!Array.isArray(raw)) return null;
  const entry = (raw as PendingContextEntry[]).find((e) => e && e.recipient === recipient);
  if (!entry) return null;
  const { recipient: _recipient, ...attachment } = entry;
  return attachment;
}

/** The attachment on an enqueued envelope (queue-time form: a single object), or null when absent or malformed. */
export function readPendingContext(metadata: Record<string, unknown> | undefined): PendingContextAttachment | null {
  const raw = metadata?.[PENDING_CONTEXT_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Partial<PendingContextAttachment>;
  const through = a.through;
  if (typeof a.conversation_id !== 'string' || !through || typeof through.created_at !== 'string' || typeof through.id !== 'string') return null;
  if (a.block !== null && typeof a.block !== 'string') return null;
  return { conversation_id: a.conversation_id, block: a.block, through: { created_at: through.created_at, id: through.id } };
}

/** True for a bus-originated envelope whose body must not be shown as a message. */
export function isSystemOnly(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[SYSTEM_ONLY_KEY] === true;
}
