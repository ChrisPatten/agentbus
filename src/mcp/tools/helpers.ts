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
