/**
 * Headless Claude Code adapter (E19).
 *
 * In-process adapter that spawns `claude -p` per message batch instead of
 * running a persistent MCP session. Runs alongside bus-core with direct DB
 * access for session continuity (--resume) and memory/summary injection.
 *
 * Flow per contact batch:
 *   1. Poll bus HTTP API for pending messages
 *   2. Group by contact, serialize per-contact via promise chaining
 *   3. Look up active session → claude_session_id for --resume
 *   4. Query memories + last session summary → interpolate system prompt
 *   5. Spawn: claude -p <prompt> --output-format stream-json [--resume <id>]
 *   6. Capture session_id and result text from stream-json events
 *   7. Store claude_session_id on the session row
 *   8. POST outbound envelope to bus
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type Database from 'better-sqlite3';
import { loadConfig } from '../config/loader.js';
import { renderSystemPrompt, expandFileReferences, type PromptContext } from './prompt-renderer.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { formatMessagesForSampling } from './cc.js';

const configPath = process.env['AGENTBUS_CONFIG'] ?? resolve(process.cwd(), 'config.yaml');
const config = loadConfig(configPath);

const headlessCfg = config.adapters['cc-headless'];

let AGENT_ID: string;
let POLL_INTERVAL_MS: number;
let CLAUDE_BIN: string;
let WORKING_DIR: string;
let busBaseUrl: string;

// ── Per-contact serialization ─────────────────────────────────────────────────

const queues = new Map<string, Promise<void>>();

function enqueue(contactId: string, task: () => Promise<void>): void {
  const prev = queues.get(contactId) ?? Promise.resolve();
  const next = prev.then(task).catch((err: unknown) => {
    console.error(`[cc-headless] Error processing batch for ${contactId}:`, err);
  });
  queues.set(contactId, next);
}

// ── DB helpers ────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  claude_session_id: string | null;
}

interface MemoryRow {
  category: string;
  content: string;
}

interface SummaryRow {
  summary: string;
  started_at: string;
  ended_at: string;
}

function getActiveSession(db: Database.Database, contactId: string, channel: string): SessionRow | null {
  return db
    .prepare(
      `SELECT id, claude_session_id FROM sessions
       WHERE contact_id = ? AND channel = ? AND ended_at IS NULL AND status = 'active'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(contactId, channel) as SessionRow | null;
}

function storeClaudeSessionId(db: Database.Database, sessionId: string, claudeId: string): void {
  db.prepare(`UPDATE sessions SET claude_session_id = ? WHERE id = ?`).run(claudeId, sessionId);
}

function getMemories(db: Database.Database, contactId: string, channel: string): MemoryRow[] {
  return db
    .prepare(
      `SELECT category, content FROM memories
       WHERE contact_id = ? AND (channel = ? OR channel IS NULL)
         AND superseded_by IS NULL
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all(contactId, channel) as MemoryRow[];
}

function getLastSummary(db: Database.Database, contactId: string, channel: string): SummaryRow | null {
  return db
    .prepare(
      `SELECT ss.summary, ss.started_at, ss.ended_at
       FROM session_summaries ss
       JOIN sessions s ON s.id = ss.session_id
       WHERE s.contact_id = ? AND ss.channel = ?
       ORDER BY ss.created_at DESC LIMIT 1`,
    )
    .get(contactId, channel) as SummaryRow | null;
}

// ── Prompt context builders ───────────────────────────────────────────────────

function formatMemories(rows: MemoryRow[]): string {
  if (rows.length === 0) return '';
  const lines = rows.map((r) => `- [${r.category}] ${r.content}`);
  return `## Memories\n${lines.join('\n')}`;
}

function formatSummary(row: SummaryRow | null): string {
  if (!row) return '';
  let text: string;
  try {
    const parsed = JSON.parse(row.summary) as { summary?: string };
    text = parsed.summary ?? row.summary;
  } catch {
    text = row.summary;
  }
  const d = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `## Last conversation (${d(row.started_at)} – ${d(row.ended_at)})\n${text}`;
}

// ── Temp file helpers ─────────────────────────────────────────────────────────

function writeTmp(content: string, suffix: string): string {
  const path = join(tmpdir(), `agentbus-${randomUUID()}${suffix}`);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function cleanTmp(...paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* best-effort */ }
  }
}

// ── claude -p invocation ──────────────────────────────────────────────────────

interface SpawnResult {
  claudeSessionId: string | null;
  resultText: string | null;
  /** True if the agent called reply/send_message during the run (owns delivery). */
  deliveredViaTool: boolean;
  error: string | null;
}

/** MCP tool names (namespaced by the server key) that deliver to the user. */
const DELIVERY_TOOL_NAMES = new Set(['mcp__agentbus__reply', 'mcp__agentbus__send_message']);

async function invokeClause(
  prompt: string,
  systemPromptPath: string,
  mcpConfigPath: string,
  resumeId: string | null,
): Promise<SpawnResult> {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--allowedTools', 'all',
    '--mcp-config', mcpConfigPath,
    '--system-prompt-file', systemPromptPath,
  ];
  if (resumeId) {
    args.push('--resume', resumeId);
  }

  return new Promise((resolve) => {
    // cwd drives which CLAUDE.md hierarchy claude -p auto-loads into context.
    const child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: WORKING_DIR });

    let claudeSessionId: string | null = null;
    let resultText: string | null = null;
    let deliveredViaTool = false;
    let errorOutput = '';
    let spawnError: string | null = null;

    child.stderr?.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as {
          type: string;
          session_id?: string;
          result?: string;
          is_error?: boolean;
          subtype?: string;
          message?: { content?: Array<{ type?: string; name?: string }> };
        };

        if (event.session_id && !claudeSessionId) {
          claudeSessionId = event.session_id;
        }

        // Watch assistant turns for reply/send_message tool calls — when the
        // agent delivers via a tool, the adapter must NOT also post stdout.
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message!.content!) {
            if (block.type === 'tool_use' && block.name && DELIVERY_TOOL_NAMES.has(block.name)) {
              deliveredViaTool = true;
            }
          }
        }

        if (event.type === 'result') {
          if (event.is_error) {
            spawnError = `claude reported error: ${event.result ?? 'unknown'}`;
          } else {
            resultText = event.result ?? null;
          }
          // Always capture final session_id from result event
          if (event.session_id) claudeSessionId = event.session_id;
        }
      } catch {
        // Non-JSON lines (rare) — ignore
      }
    });

    child.on('error', (err) => {
      spawnError = `spawn failed: ${err.message}`;
    });

    child.on('close', (code) => {
      rl.close();
      if (spawnError) {
        resolve({ claudeSessionId, resultText: null, deliveredViaTool, error: spawnError });
      } else if (code !== 0 && resultText === null) {
        const detail = errorOutput.slice(-500).trim() || `exit code ${code}`;
        resolve({ claudeSessionId, resultText: null, deliveredViaTool, error: detail });
      } else {
        resolve({ claudeSessionId, resultText, deliveredViaTool, error: null });
      }
    });
  });
}

// ── Outbound delivery ─────────────────────────────────────────────────────────

/**
 * Tell the source adapter to start its typing indicator while claude -p runs.
 * Fire-and-forget — no-ops server-side for channels without typing capability.
 */
function startTyping(channel: string, contactId: string): void {
  fetch(`${busBaseUrl}/api/v1/adapters/${channel}/typing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId }),
  }).catch(() => {});
}

async function deliverResponse(
  original: MessageEnvelope,
  resultText: string,
): Promise<void> {
  const body = {
    channel: original.channel,
    topic: original.topic,
    sender: AGENT_ID,
    recipient: original.sender,
    reply_to: original.id,
    priority: 'normal',
    payload: { type: 'text', body: resultText },
    metadata: {},
  };

  const res = await fetch(`${busBaseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`Bus rejected outbound: ${data.error ?? `HTTP ${res.status}`}`);
  }
}

// ── Batch processor ───────────────────────────────────────────────────────────

async function processBatch(
  envelopes: MessageEnvelope[],
  db: Database.Database,
): Promise<void> {
  const first = envelopes[0]!;
  const contactId = first.sender;  // contact:alice after pipeline resolution
  const channel = first.channel;

  // Show activity on the source channel while the (cold-start) claude -p runs.
  startTyping(channel, contactId);

  // Look up active session for --resume
  const session = getActiveSession(db, contactId, channel);
  const resumeId = session?.claude_session_id ?? null;

  // Build system prompt context
  const memories = getMemories(db, contactId, channel);
  const lastSummary = getLastSummary(db, contactId, channel);

  const ctx: PromptContext = {
    contact_id: contactId,
    channel,
    date: new Date().toISOString().slice(0, 10),
    memories: formatMemories(memories),
    session_summary: formatSummary(lastSummary),
    agent_id: AGENT_ID,
  };

  // Render {{vars}} then expand @path file references (trusted operator config).
  const systemPromptText = expandFileReferences(
    renderSystemPrompt(headlessCfg!.system_prompt, ctx),
    WORKING_DIR,
  );
  // Memories/summary are injected via the system prompt above, so suppress the
  // Stage-85 <memory> block in the user message to avoid double injection.
  const prompt = formatMessagesForSampling(envelopes, { includeMemoryContext: false });

  // Write temp files
  const spPath = writeTmp(systemPromptText, '.txt');
  const mcpConfig = {
    mcpServers: {
      agentbus: {
        type: 'stdio',
        command: 'npx',
        args: ['tsx', resolve(process.cwd(), 'src/adapters/cc.js')],
        env: {
          AGENTBUS_TOOLS_ONLY: 'true',
          AGENTBUS_CONFIG: configPath,
        },
      },
    },
  };
  const mcpPath = writeTmp(JSON.stringify(mcpConfig), '.json');

  try {
    const { claudeSessionId, resultText, deliveredViaTool, error } = await invokeClause(
      prompt,
      spPath,
      mcpPath,
      resumeId,
    );

    // Store claude_session_id on the active session
    if (claudeSessionId && session) {
      try {
        storeClaudeSessionId(db, session.id, claudeSessionId);
      } catch (err) {
        console.error(`[cc-headless] Failed to store claude_session_id for ${session.id}:`, err);
      }
    }

    // The agent owns delivery via the reply/send_message tools. Only the adapter
    // steps in when the agent delivered nothing through a tool:
    //   - on failure / no result → send the configured error_reply (no silence)
    //   - otherwise → fall back to delivering the stdout result text
    if (deliveredViaTool) {
      if (error) {
        console.error(`[cc-headless] claude reported an error for ${contactId} after delivering via tool: ${error}`);
      }
      return;
    }

    if (error || !resultText) {
      console.error(`[cc-headless] claude invocation failed for ${contactId}: ${error ?? 'no result'}`);
      await deliverResponse(first, headlessCfg!.error_reply);
      return;
    }

    await deliverResponse(first, resultText);
  } finally {
    cleanTmp(spPath, mcpPath);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

async function poll(db: Database.Database): Promise<void> {
  if (shuttingDown) return;

  try {
    const res = await fetch(
      `${busBaseUrl}/api/v1/messages/pending?agent=${headlessCfg!.agent_id}&limit=20`,
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as {
      ok: boolean;
      messages: MessageEnvelope[];
    };

    // Ack all messages upfront, then group survivors by sender
    const acked: MessageEnvelope[] = [];
    await Promise.all(
      data.messages.map(async (env) => {
        try {
          const ackRes = await fetch(`${busBaseUrl}/api/v1/messages/${env.id}/ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'delivered' }),
          });
          if (ackRes.ok) acked.push(env);
          else console.error(`[cc-headless] ack rejected for ${env.id}: HTTP ${ackRes.status}`);
        } catch (err) {
          console.error(`[cc-headless] ack failed for ${env.id}:`, err);
        }
      }),
    );

    // Group by sender and enqueue per-contact
    const bySender = new Map<string, MessageEnvelope[]>();
    for (const env of acked) {
      const group = bySender.get(env.sender) ?? [];
      group.push(env);
      bySender.set(env.sender, group);
    }

    for (const [contactId, batch] of bySender) {
      const batchCopy = [...batch];
      enqueue(contactId, () => processBatch(batchCopy, db));
    }
  } catch (err) {
    console.error('[cc-headless] Poll error:', err);
  }

  if (!shuttingDown) {
    pollTimer = setTimeout(() => void poll(db), POLL_INTERVAL_MS);
  }
}

// ── Lifecycle (standalone mode) ───────────────────────────────────────────────

/**
 * Start the headless adapter as a standalone process.
 * When running in-process via index.ts, call startHeadless() instead.
 */
export function startHeadless(db: Database.Database): void {
  if (!headlessCfg) {
    console.warn('[cc-headless] No cc-headless adapter config found — skipping');
    return;
  }
  AGENT_ID = `agent:${headlessCfg.agent_id}`;
  POLL_INTERVAL_MS = headlessCfg.poll_interval_ms;
  CLAUDE_BIN = headlessCfg.claude_bin;
  WORKING_DIR = headlessCfg.working_dir ?? process.cwd();
  busBaseUrl = `http://127.0.0.1:${config.bus.http_port}`;
  console.log(`[cc-headless] Starting — polling ${busBaseUrl} for ${AGENT_ID} every ${POLL_INTERVAL_MS}ms`);
  void poll(db);
}

export function stopHeadless(): void {
  shuttingDown = true;
  if (pollTimer !== null) clearTimeout(pollTimer);
}
