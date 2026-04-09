import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Factory: creates the MCP server instance for the claude-code adapter.
 * Stateless — call once at startup and keep the returned instance.
 */
export function createMcpServer(): McpServer {
  return new McpServer(
    { name: 'agentbus-claude-code', version: '0.1.0' },
    { capabilities: { logging: {} } }
  );
}
