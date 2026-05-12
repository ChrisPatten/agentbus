import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Factory: creates the MCP server instance for the claude-code adapter.
 * Stateless — call once at startup and keep the returned instance.
 */
export function createMcpServer(): McpServer {
  return new McpServer(
    { name: 'agentbus-claude-code', version: '0.1.0' },
    {
      capabilities: {
        logging: {},
        experimental: {
          // Declares support for push-style channel notifications so Claude Code
          // registers a listener and wakes up when a notification/claude/channel
          // event arrives.
          'claude/channel': {},
        },
      },
      instructions: [
        'Messages arrive as a new user turn in this format:',
        '',
        '  New message from <sender> via <channel> at <timestamp> [id:<message-id>]:',
        '  <body>',
        '',
        'Multiple messages in one turn are separated by a blank line, each with its own [id:...] tag.',
        '',
        'To reply, call reply(message_id="<id>", body="..."). The tool resolves the channel and recipient automatically.',
        'To show a typing/processing indicator, call react_to_message(message_id="<id>", emoji="👀") before long-running work.',
        'The [id:...] value is stable — use the id from each message to reply to that specific message.',
      ].join('\n'),
    }
  );
}
