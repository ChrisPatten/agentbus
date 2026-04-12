/**
 * S7.1 — Channel Discovery: list_channels
 *
 * Calls GET /api/v1/adapters on bus-core and returns each adapter's
 * id, name, channels[], and capabilities summary.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';
import type { AdaptersResponse } from './types.js';

export function registerChannelTools(server: McpServer, busBaseUrl: string): void {
  server.registerTool(
    'list_channels',
    {
      description:
        'List all available channels and their adapter capabilities. Use this to discover where you can send messages.',
    },
    async () => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/adapters`);
        if (!res.ok) {
          return toolError(`Failed to fetch adapters: HTTP ${res.status}`);
        }
        const data = (await res.json()) as AdaptersResponse;
        return toolSuccess(data.adapters);
      } catch (err) {
        return toolError(`Failed to list channels: ${String(err)}`);
      }
    }
  );
}
