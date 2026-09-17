/**
 * S48.2a — per-pane MCP config generation for the interactive Claude Code
 * session pool (E48).
 *
 * A project's checked-in `.mcp.json` (e.g.
 * ~/workspace/peggy-claude-code/.mcp.json) hardcodes a single
 * `AGENTBUS_AGENT_ID` for its `agentbus` MCP server entry. If N pool panes
 * all launched `claude` in that same `working_dir` using that same
 * `.mcp.json` unmodified, all N panes would claim the same agent id and
 * steal each other's messages — see
 * `_bmad-output/epics/E48-cc-session-pool-tmux.md`, "S48.2a — Per-Pane Agent
 * Identity", option (b). This module never edits a project's own
 * `.mcp.json` (and must not — it typically lives outside this repo
 * entirely). Instead it generates a per-pane config file at launch time: the
 * project's *other* servers (e.g. a "bmp" entry) are deep-copied in so they
 * still work in the pane, and the `agentbus` key is always overwritten with
 * this pane's own identity.
 *
 * The caller passes the returned path to
 * `claude --mcp-config <path> --strict-mcp-config`. `--strict-mcp-config`
 * makes the CLI use ONLY the server(s) in the file(s) it's given and ignore
 * the project's own `.mcp.json` entirely — that's what actually keeps a
 * stale/duplicate `agentbus` entry in the project file from ever reaching
 * the pane. That only works because this module copies the project's other
 * servers in itself first; without that copy, `--strict-mcp-config` would
 * silently drop them (e.g. "bmp").
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Same idiom already used in src/db/schema.ts for a module-relative path.
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the full interactive adapter (`src/adapters/cc.ts`),
 * resolved relative to *this module's own location* — deliberately NOT
 * `workingDir` or `process.cwd()`, either of which points somewhere else
 * depending on which pane/process calls this. Targets `cc.js`, not `cc.ts`:
 * under this project's `"module": "NodeNext"` tsconfig, `tsx` resolves a
 * `.js` specifier to the co-located `.ts` source file, so `cc.js` is correct
 * even though only `cc.ts` exists on disk — this mirrors the identical
 * pattern in `src/adapters/cc-headless.ts`'s `buildMcpConfig()`, which
 * targets `src/adapters/cc.js` the same way (just resolved from
 * `process.cwd()` there, since that module only ever runs from the repo
 * root — this one can't assume that).
 */
const CC_ADAPTER_PATH = resolve(__dirname, '../adapters/cc.js');

export interface PaneMcpConfigOptions {
  /** The pane's own bare agent id, e.g. "peggy-pool-2" (NOT prefixed with "agent:"). */
  paneAgentId: string;
  /** Absolute path to the agentbus config.yaml this pane's cc.ts should load (AGENTBUS_CONFIG). */
  agentbusConfigPath: string;
  /** The project working_dir this pane's `claude` process will run in — used to locate an existing `.mcp.json` to merge additional servers from, if present. */
  workingDir: string;
  /** Directory to write the generated per-pane config file into (a tmp/scratch dir is fine). */
  outDir: string;
}

/**
 * Build a per-pane MCP config file and return its absolute path. The caller
 * passes this path to `claude --mcp-config <path> --strict-mcp-config`.
 */
export function writePaneMcpConfig(opts: PaneMcpConfigOptions): string {
  const mcpServers = loadProjectServers(opts.workingDir);

  // Always overwrite — regardless of whether the project file already had
  // its own "agentbus" entry (the exact hazard this module exists to
  // prevent), this pane's own identity wins.
  mcpServers['agentbus'] = {
    type: 'stdio',
    command: 'npx',
    args: ['tsx', CC_ADAPTER_PATH],
    env: {
      AGENTBUS_CONFIG: opts.agentbusConfigPath,
      AGENTBUS_AGENT_ID: opts.paneAgentId,
    },
  };

  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `pool-mcp-${randomUUID()}.json`);
  writeFileSync(outPath, JSON.stringify({ mcpServers }, null, 2), 'utf-8');
  return outPath;
}

/**
 * Best-effort cleanup — deletes the file written by `writePaneMcpConfig`.
 * Never throws (file already gone, permission issue, etc.), matching the
 * `cleanTmp` pattern in `src/adapters/cc-headless.ts`.
 */
export function cleanupPaneMcpConfig(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

// ── Project .mcp.json merge ────────────────────────────────────────────────

/**
 * Reads `${workingDir}/.mcp.json` and returns a deep copy of its
 * `mcpServers` object, so unrelated servers the project already configures
 * (e.g. a "bmp" entry) are preserved for the pane. A missing file, invalid
 * JSON, or a missing/malformed `mcpServers` key are all non-fatal: this pane
 * just gets `agentbus` alone afterward, once the caller sets it — never
 * throws, only logs via `console.error`.
 */
function loadProjectServers(workingDir: string): Record<string, unknown> {
  const projectMcpPath = join(workingDir, '.mcp.json');

  if (!existsSync(projectMcpPath)) {
    console.error(`[pool/mcp-config] No .mcp.json at ${projectMcpPath} — pane will get agentbus alone`);
    return {};
  }

  try {
    const raw = readFileSync(projectMcpPath, 'utf-8');
    const parsed = JSON.parse(raw) as { mcpServers?: unknown } | null;
    const mcpServers = parsed?.mcpServers;
    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
      console.error(
        `[pool/mcp-config] ${projectMcpPath} has no "mcpServers" object — pane will get agentbus alone`,
      );
      return {};
    }
    // Deep copy via JSON round-trip: mcpServers is itself the output of
    // JSON.parse, so every value in it is already JSON-safe.
    return JSON.parse(JSON.stringify(mcpServers)) as Record<string, unknown>;
  } catch (err) {
    console.error(`[pool/mcp-config] Failed to parse ${projectMcpPath} — pane will get agentbus alone:`, err);
    return {};
  }
}
