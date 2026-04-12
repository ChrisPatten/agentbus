/**
 * Shared types for MCP tool files — avoids duplicating bus API response shapes.
 */

export interface AdapterSummary {
  id: string;
  name: string;
  channels: string[];
  capabilities: Record<string, unknown>;
}

export interface AdaptersResponse {
  ok: boolean;
  adapters: AdapterSummary[];
}
