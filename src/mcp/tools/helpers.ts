/**
 * Shared MCP tool response helpers.
 *
 * All tools should use these helpers for consistent response shapes per MCP spec.
 */

/** Return a structured MCP error response. Never throws. */
export function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

/** Return a successful MCP tool response with JSON-serialized data. */
export function toolSuccess(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

/**
 * Agent-to-user sends are delivered by the delivery worker, which only picks up
 * `contact:`-prefixed recipients (or `agent:` ones polled by an agent). Anything
 * else (e.g. a channel string such as "telegram:peggy:group:-100...") is accepted
 * by the queue but never dequeued, so the row sits `pending` forever while the
 * tool reports success. Returns an error message for such a recipient, else null.
 */
export function recipientError(to: string): string | null {
  if (to.startsWith('contact:') || to.startsWith('agent:')) return null;
  return (
    `Invalid recipient "${to}": it must be a contact or agent id such as "contact:chris". ` +
    'A channel or chat id is not a recipient (pass it as `channel` and `topic`); a message with this recipient would never be delivered.'
  );
}
