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
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type Database from 'better-sqlite3';
import { loadConfig } from '../config/loader.js';
import { renderSystemPrompt, expandFileReferences, type PromptContext } from './prompt-renderer.js';
import { assembleMemoryContext, formatLocalDate } from './memory-context.js';
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
  contact_id: string;
  channel: string;
}

/**
 * E20: look up the active session by conversation_id. Long-lived headless
 * sessions are keyed on conversation_id so each email thread resumes its own
 * session and a long-lived Telegram conversation resumes the same one. Sessions
 * are never force-closed on idle (ended_at stays NULL), so no status filter.
 */
function getActiveSession(db: Database.Database, conversationId: string): SessionRow | null {
  return db
    .prepare(
      `SELECT id, claude_session_id, contact_id, channel FROM sessions
       WHERE conversation_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(conversationId) as SessionRow | null;
}

function storeClaudeSessionId(db: Database.Database, sessionId: string, claudeId: string): void {
  db.prepare(`UPDATE sessions SET claude_session_id = ? WHERE id = ?`).run(claudeId, sessionId);
}

/**
 * Resolve the conversation_id for a batch from the first message's transcript
 * row — the authoritative value Stage 70 computed. Falls back to deriving it
 * (sha256 of sorted [contact_id, channel, topic]) on the rare chance the
 * transcript row is missing (Stage 80 is critical:false).
 */
function resolveConversationId(db: Database.Database, env: MessageEnvelope): string {
  const row = db
    .prepare(
      `SELECT conversation_id FROM transcripts WHERE message_id = ? ORDER BY created_at ASC LIMIT 1`,
    )
    .get(env.id) as { conversation_id: string } | undefined;
  if (row) return row.conversation_id;

  const contactId = env.sender.startsWith('contact:') ? env.sender.slice('contact:'.length) : env.sender;
  const parts = [contactId, env.channel, env.topic].sort();
  return createHash('sha256').update(parts.join(':')).digest('hex');
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
    '--verbose', // required by the CLI when --print is combined with --output-format=stream-json
    '--allowedTools', 'all',
    '--mcp-config', mcpConfigPath,
    '--system-prompt-file', systemPromptPath,
  ];
  if (resumeId) {
    args.push('--resume', resumeId);
  }

  return new Promise((resolve) => {
    // cwd drives which CLAUDE.md hierarchy claude -p auto-loads into context.
    // CLAUDE_CODE_DISABLE_AUTO_MEMORY: the adapter already injects the agent's
    // memory files via {{memories}} in the system prompt, so the CLI's native
    // auto-memory feature would load MEMORY.md a second time. Disable it here so
    // every headless agent avoids the double-load without per-agent config.
    const child = spawn(CLAUDE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: WORKING_DIR,
      env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    });

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
 * Email channels have no typing indicator, so skip the call entirely.
 */
function startTyping(channel: string, contactId: string): void {
  if (channel === 'email' || channel.startsWith('email:')) return;
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

// ── Turn runner (shared by normal + journaling turns) ──────────────────────────

/** Build the stdio MCP config that exposes the headless tool subset to claude -p. */
function buildMcpConfig(): unknown {
  return {
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
}

/**
 * Render the system prompt, write temp files, invoke claude -p, and persist any
 * new claude_session_id. Shared by normal turns (processBatch) and silent
 * journaling turns (runJournalingTurn). The memory context block is assembled
 * fresh from the agent's files on every call.
 */
async function runClaudeTurn(opts: {
  db: Database.Database;
  session: SessionRow | null;
  contactId: string;
  channel: string;
  prompt: string;
  resumeId: string | null;
}): Promise<SpawnResult> {
  const now = new Date();
  const ctx: PromptContext = {
    contact_id: opts.contactId,
    channel: opts.channel,
    date: formatLocalDate(now),
    memories: assembleMemoryContext(WORKING_DIR, headlessCfg!.memory, now),
    // E20: structured DB summaries are retired; files are the source of truth.
    session_summary: '',
    agent_id: AGENT_ID,
  };

  // Render {{vars}} then expand @path file references (trusted operator config).
  const systemPromptText = expandFileReferences(
    renderSystemPrompt(headlessCfg!.system_prompt, ctx),
    WORKING_DIR,
  );

  const spPath = writeTmp(systemPromptText, '.txt');
  const mcpPath = writeTmp(JSON.stringify(buildMcpConfig()), '.json');

  try {
    const result = await invokeClause(opts.prompt, spPath, mcpPath, opts.resumeId);
    // Persist the claude_session_id so subsequent turns --resume the same one.
    if (result.claudeSessionId && opts.session) {
      try {
        storeClaudeSessionId(opts.db, opts.session.id, result.claudeSessionId);
      } catch (err) {
        console.error(`[cc-headless] Failed to store claude_session_id for ${opts.session.id}:`, err);
      }
    }
    return result;
  } finally {
    cleanTmp(spPath, mcpPath);
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

  // E20: key resume on conversation_id (per-thread sessions, long-lived).
  const conversationId = resolveConversationId(db, first);
  const session = getActiveSession(db, conversationId);
  const resumeId = session?.claude_session_id ?? null;

  // Memory is injected via the system prompt (assembleMemoryContext), so suppress
  // the Stage-85 <memory> block in the user message to avoid double injection.
  const prompt = formatMessagesForSampling(envelopes, { includeMemoryContext: false });

  const { resultText, deliveredViaTool, error } = await runClaudeTurn({
    db,
    session,
    contactId,
    channel,
    prompt,
    resumeId,
  });

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
}

// ── Silent journaling turn (E20) ────────────────────────────────────────────────

/**
 * Fire a silent `--resume` journaling turn for a paused conversation: the agent
 * reviews the conversation and updates its own memory files. Nothing is
 * delivered to the user (no deliverResponse, no stdout fallback, no typing
 * indicator). Serialized through the same per-contact queue as normal turns so
 * a journaling turn never races a live reply on the same claude_session_id.
 *
 * Resolves `{ skipped: true }` when the session has no claude_session_id yet
 * (the agent never spoke — nothing to journal); the dispatcher stamps it
 * journaled anyway. Rejects on invocation error so the dispatcher leaves
 * last_journaled_at unchanged and retries on a later tick.
 */
function runJournalingTurn(conversationId: string, db: Database.Database): Promise<{ skipped?: boolean }> {
  const session = getActiveSession(db, conversationId);
  if (!session || !session.claude_session_id) {
    return Promise.resolve({ skipped: true });
  }

  const queueKey = `contact:${session.contact_id}`;
  return new Promise((resolveP, rejectP) => {
    enqueue(queueKey, async () => {
      const result = await runClaudeTurn({
        db,
        session,
        contactId: session.contact_id,
        channel: session.channel,
        prompt: headlessCfg!.journaling.prompt,
        resumeId: session.claude_session_id,
      });
      // Silent: never deliver. Any reply/send_message the agent chose to call
      // already went through the MCP tool — the adapter posts nothing here.
      if (result.error) {
        rejectP(new Error(result.error));
        return;
      }
      resolveP({});
    });
  });
}

/**
 * Fire a silent background journaling turn for an explicit claude session id,
 * independent of the DB session row. Used by the `/clear` command: the bus has
 * already set `ended_at` on the session (so the next message starts fresh), but
 * the underlying claude session still exists on disk and can be resumed for one
 * final memory pass. Serialized through the same per-contact queue so it never
 * races a live turn. Failures are logged, not surfaced — journaling is silent.
 */
function journalResumeId(
  db: Database.Database,
  opts: { claudeSessionId: string; contactId: string; channel: string },
): void {
  const queueKey = `contact:${opts.contactId}`;
  enqueue(queueKey, async () => {
    try {
      const result = await runClaudeTurn({
        db,
        session: null, // session already closed; nothing to persist back
        contactId: opts.contactId,
        channel: opts.channel,
        prompt: headlessCfg!.journaling.prompt,
        resumeId: opts.claudeSessionId,
      });
      if (result.error) {
        console.error(`[cc-headless] /clear journaling failed for ${opts.contactId}: ${result.error}`);
      }
    } catch (err) {
      console.error(`[cc-headless] /clear journaling threw for ${opts.contactId}:`, err);
    }
  });
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

/** Handle returned by startHeadless for the bus to drive journaling turns. */
export interface HeadlessHandle {
  /**
   * Fire a silent journaling turn for the given conversation. Resolves with
   * `{ skipped: true }` when there is nothing to journal; rejects on error.
   */
  runJournalingTurn(conversationId: string): Promise<{ skipped?: boolean }>;
  /**
   * Fire a silent background journaling turn for an explicit claude session id
   * whose DB session row has already been closed (used by `/clear`).
   */
  journalResumeId(opts: { claudeSessionId: string; contactId: string; channel: string }): void;
}

/**
 * Start the headless adapter as a standalone process.
 * When running in-process via index.ts, call startHeadless() instead.
 *
 * Returns a HeadlessHandle the SessionTracker uses to dispatch journaling
 * turns, or null when no cc-headless config is present.
 */
export function startHeadless(db: Database.Database): HeadlessHandle | null {
  if (!headlessCfg) {
    console.warn('[cc-headless] No cc-headless adapter config found — skipping');
    return null;
  }
  AGENT_ID = `agent:${headlessCfg.agent_id}`;
  POLL_INTERVAL_MS = headlessCfg.poll_interval_ms;
  CLAUDE_BIN = headlessCfg.claude_bin;
  WORKING_DIR = headlessCfg.working_dir ?? process.cwd();
  busBaseUrl = `http://127.0.0.1:${config.bus.http_port}`;
  console.log(`[cc-headless] Starting — polling ${busBaseUrl} for ${AGENT_ID} every ${POLL_INTERVAL_MS}ms`);
  void poll(db);
  return {
    runJournalingTurn: (conversationId: string) => runJournalingTurn(conversationId, db),
    journalResumeId: (opts) => journalResumeId(db, opts),
  };
}

export function stopHeadless(): void {
  shuttingDown = true;
  if (pollTimer !== null) clearTimeout(pollTimer);
}
