/**
 * Headless Claude Code adapter (E19, multi-instance since E23).
 *
 * In-process adapter that spawns `claude -p` per message batch instead of
 * running a persistent MCP session. Runs alongside bus-core with direct DB
 * access for session continuity (--resume) and memory/summary injection.
 *
 * Each configured `cc-headless` entry (legacy single-instance or named record,
 * see `getCcHeadlessInstances`) becomes an independent `HeadlessInstance` with
 * its own state (agent id, working dir, per-conversation queue, poll
 * timer) — multiple headless agents can run concurrently in one process
 * without sharing mutable state.
 *
 * Flow per conversation batch:
 *   1. Poll bus HTTP API for pending messages scoped to this instance's agent_id
 *   2. Group by conversation, serialize within it via promise chaining
 *   3. Look up active session → claude_session_id for --resume
 *   4. Assemble memory blocks; for a real session, filter to new/changed
 *      blocks via the context-block ledger (context-ledger.ts) and prepend
 *      only those to the user turn — the system prompt itself stays a frozen
 *      cache prefix (no {{memories}}). With no session, fall back to
 *      inlining the full memory context into the system prompt as before.
 *   5. Spawn: claude -p <prompt> --output-format stream-json [--resume <id>]
 *   6. Capture session_id and result text from stream-json events
 *   7. Store claude_session_id on the session row; mark sent blocks in the ledger
 *   8. POST outbound envelope to bus
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type Database from 'better-sqlite3';
import { loadConfig } from '../config/loader.js';
import { getCcHeadlessInstances, type CcHeadlessInstanceConfig } from '../config/schema.js';
import { renderSystemPrompt, expandFileReferences, type PromptContext } from './prompt-renderer.js';
import { assembleMemoryContext, assembleMemoryBlocks, formatLocalDate } from './memory-context.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { formatMessagesForSampling } from './cc.js';
import { formatToolCallSummary } from './tool-call-summary.js';
import { resolveModel } from './model-override-loader.js';
import { hashBlock, shouldSendBlock, markBlockSent, clearLedger, detectCompaction } from './context-ledger.js';
import { HeadlessLimiter, type TurnClass } from './headless-limiter.js';

const configPath = resolve(process.env['AGENTBUS_CONFIG'] ?? 'config.yaml');
const config = loadConfig(configPath);

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

/** E39 — persist one turn's cost/usage/turn-count to turn_costs, keyed by agent. */
function recordTurnCost(
  db: Database.Database,
  opts: {
    agentId: string;
    sessionId: string | null;
    costUsd: number;
    inputTokens: number | null;
    outputTokens: number | null;
    numTurns: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO turn_costs (agent_id, session_id, ts, cost_usd, input_tokens, output_tokens, num_turns)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.agentId,
    opts.sessionId,
    new Date().toISOString(),
    opts.costUsd,
    opts.inputTokens,
    opts.outputTokens,
    opts.numTurns,
  );
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

  const boundConversation = env.metadata?.['conversation_id'];
  if (typeof boundConversation === 'string' && boundConversation.length > 0) return boundConversation;

  const parts = [normalizeContactId(env.sender), env.channel, env.topic].sort();
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

/**
 * Strip the "contact:" prefix if present. `processBatch()` keys turns by the
 * envelope's raw `sender` ("contact:chris"), but journaling turns key by the
 * bare `sessions.contact_id` ("chris") — normalizing both to the same form
 * here means `activeChildren`/`stoppedByUser` (used by `/stop`) find a turn
 * regardless of which path spawned it.
 */
export function normalizeContactId(contactId: string): string {
  return contactId.startsWith('contact:') ? contactId.slice('contact:'.length) : contactId;
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

/** Build the stdio MCP config for this headless agent's tool subprocess. */
function buildMcpConfig(agentId: string): unknown {
  return {
    mcpServers: {
      agentbus: {
        type: 'stdio',
        command: 'npx',
        args: ['tsx', resolve(process.cwd(), 'src/adapters/cc.js')],
        env: {
          AGENTBUS_TOOLS_ONLY: 'true',
          AGENTBUS_CONFIG: configPath,
          AGENTBUS_AGENT_ID: agentId,
        },
      },
    },
  };
}

// ── claude -p invocation ──────────────────────────────────────────────────────

interface SpawnResult {
  claudeSessionId: string | null;
  resultText: string | null;
  /** True if the agent called reply/send_message during the run (owns delivery). */
  deliveredViaTool: boolean;
  error: string | null;
  /** True if `/stop` killed this turn. The caller must not treat this as a
   * failure needing an error reply — the Telegram adapter already finalized
   * any open draft with a "Stopped by user" note. */
  stoppedByUser: boolean;
  /** E39 — from the `result` event's `total_cost_usd`. Null when the event
   * never carried cost data (e.g. the process was killed by `/stop` before a
   * `result` event arrived), so callers can skip recording a fabricated 0. */
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

/** MCP tool names (namespaced by the server key) that deliver to the user. */
const DELIVERY_TOOL_NAMES = new Set(['mcp__agentbus__reply', 'mcp__agentbus__send_message']);

const ERROR_DETAIL_MAX_LENGTH = 500;

/** One tool_use content block from a stream-json `assistant` event, with
 * delivery-tool detection folded in so extraction and delivery detection
 * happen in a single pass over `event.message.content`. */
export interface ExtractedToolCall {
  name: string;
  input: Record<string, unknown>;
  isDelivery: boolean;
}

/**
 * Pure. Extracts tool_use blocks from a single stream-json event. Returns []
 * for any non-`assistant` event or one with no content array — exported so
 * this can be unit-tested with plain object fixtures, no process spawning.
 */
export function extractToolCalls(event: {
  type?: string;
  message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> };
}): ExtractedToolCall[] {
  if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
  const calls: ExtractedToolCall[] = [];
  for (const block of event.message.content) {
    if (block.type !== 'tool_use' || !block.name) continue;
    const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
    calls.push({ name: block.name, input, isDelivery: DELIVERY_TOOL_NAMES.has(block.name) });
  }
  return calls;
}

/**
 * Pure. Filters `calls` (one event's worth, in order) down to the ones that
 * should be reported via onToolCall, given whether delivery has already
 * happened earlier in the run. A turn doesn't necessarily end the instant
 * reply/send_message fires — the agent can keep working afterward — but the
 * user already has their answer by then, so no further tool-call line should
 * reopen the (already-overwritten) status trail. Once a delivery call is
 * seen, every call from that point on (including later ones in the same
 * event) is suppressed.
 */
export function selectReportableCalls(
  calls: ExtractedToolCall[],
  alreadyDelivered: boolean,
): { reportable: ExtractedToolCall[]; delivered: boolean } {
  let delivered = alreadyDelivered;
  const reportable: ExtractedToolCall[] = [];
  for (const call of calls) {
    if (call.isDelivery) {
      delivered = true;
    } else if (!delivered) {
      reportable.push(call);
    }
  }
  return { reportable, delivered };
}

/** Handle returned per instance for the bus to drive journaling turns. */
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
  journalResumeId(opts: { claudeSessionId: string; contactId: string; channel: string; conversationId?: string }): void;
  /**
   * Kill the in-flight `claude -p` turn for `contactId`, if one is running
   * (used by `/stop`). Returns true if a turn was found and killed, false if
   * none was running.
   */
  stopTurn(conversationId: string): boolean;
  subscribeActivity(listener: (event: HeadlessActivityEvent) => void): () => void;
  snapshot(): HeadlessCapacitySnapshot;
}

export interface HeadlessCapacitySnapshot {
  agent_id: string;
  running_user: number;
  running_system: number;
  waiting: number;
  limit: number;
  reserved_system_slots: number;
}

export interface HeadlessActivityEvent extends HeadlessCapacitySnapshot {
  conversation_id: string;
  session_id?: string;
  state: 'queued' | 'running' | 'idle';
  turn_class: TurnClass;
}

/**
 * A single headless agent's runtime state and behavior: poll loop, per-conversation
 * serialization queue, and claude -p invocation. Fully self-contained — running
 * N instances concurrently in one process never shares mutable state between
 * them (E23).
 */
class HeadlessInstance {
  private readonly cfg: CcHeadlessInstanceConfig;
  private readonly agentId: string;
  private readonly workingDir: string;
  private readonly busBaseUrl: string;
  private readonly label: string;
  private readonly queues = new Map<string, Promise<void>>();
  /** Serialize turns that resume the same Claude transcript even after an Earlier fork changes conversation ID. */
  private readonly resumeTails = new Map<string, Promise<void>>();
  private readonly limiter: HeadlessLimiter;
  private readonly waiting = new Map<string, AbortController[]>();
  private readonly listeners = new Set<(event: HeadlessActivityEvent) => void>();
  private journalTail: Promise<void> = Promise.resolve();
  /** In-flight `claude -p` child processes, keyed by conversation ID. */
  private readonly activeChildren = new Map<string, ChildProcess>();
  /** contactIds whose in-flight turn was killed via `/stop` — consulted once,
   * by that turn's own close handler, to skip the normal error-reply path. */
  private readonly stoppedByUser = new Set<string>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(cfg: CcHeadlessInstanceConfig, busBaseUrl: string) {
    this.cfg = cfg;
    this.agentId = `agent:${cfg.agent_id}`;
    this.workingDir = cfg.working_dir ?? process.cwd();
    this.busBaseUrl = busBaseUrl;
    this.label = cfg.name ? `cc-headless:${cfg.name}` : 'cc-headless';
    this.limiter = new HeadlessLimiter(cfg.max_concurrent_turns, cfg.reserved_system_slots);
  }

  snapshot(): HeadlessCapacitySnapshot {
    const capacity = this.limiter.snapshot();
    const waiting = [...this.waiting.values()].reduce((count, entries) => count + entries.length, 0);
    return { agent_id: this.agentId, ...capacity, waiting };
  }

  subscribeActivity(listener: (event: HeadlessActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitActivity(conversationId: string, sessionId: string | undefined,
    state: HeadlessActivityEvent['state'], turnClass: TurnClass): void {
    const event: HeadlessActivityEvent = {
      ...this.snapshot(), conversation_id: conversationId, session_id: sessionId,
      state, turn_class: turnClass,
    };
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { console.error(`[${this.label}] activity listener failed:`, error); }
    }
  }

  // ── Per-conversation serialization and per-instance capacity ─────────────

  private enqueue(conversationId: string, sessionId: string | undefined, turnClass: TurnClass,
    journal: boolean, task: () => Promise<void>, resumeId?: string | null): Promise<void> {
    const previous = (this.queues.get(conversationId) ?? Promise.resolve()).catch(() => {});
    const controller = new AbortController();
    const entries = this.waiting.get(conversationId) ?? [];
    entries.push(controller);
    this.waiting.set(conversationId, entries);
    const queuedAt = Date.now();
    this.emitActivity(conversationId, sessionId, 'queued', turnClass);
    let releaseJournal: (() => void) | undefined;
    const journalGate = journal ? new Promise<void>((resolve) => { releaseJournal = resolve; }) : undefined;
    const previousJournal = this.journalTail;
    if (journalGate) this.journalTail = journalGate;
    const previousResume = resumeId ? (this.resumeTails.get(resumeId) ?? Promise.resolve()) : Promise.resolve();
    let releaseResume: (() => void) | undefined;
    const resumeGate = resumeId ? new Promise<void>(resolve => { releaseResume = resolve; }) : undefined;
    if (resumeId && resumeGate) this.resumeTails.set(resumeId, resumeGate);
    const next = previous.then(async () => {
      let release: (() => void) | undefined;
      let startedAt: number | undefined;
      try {
        if (journal) await previousJournal;
        await previousResume;
        if (controller.signal.aborted) throw new Error('turn cancelled');
        release = await this.limiter.acquire(turnClass, controller.signal);
        const pending = this.waiting.get(conversationId);
        if (pending) {
          const index = pending.indexOf(controller);
          if (index >= 0) pending.splice(index, 1);
          if (pending.length === 0) this.waiting.delete(conversationId);
        }
        startedAt = Date.now();
        this.emitActivity(conversationId, sessionId, 'running', turnClass);
        console.log(`[${this.label}] turn start class=${turnClass} conversation=${conversationId.slice(0, 8)} wait_ms=${startedAt - queuedAt}`);
        await task();
      } catch (error) {
        if (!controller.signal.aborted) console.error(`[${this.label}] Error processing ${conversationId.slice(0, 8)}:`, error);
        throw error;
      } finally {
        if (startedAt !== undefined) {
          console.log(`[${this.label}] turn settle class=${turnClass} conversation=${conversationId.slice(0, 8)} run_ms=${Date.now() - startedAt}`);
        }
        release?.();
        releaseResume?.();
        if (resumeId && this.resumeTails.get(resumeId) === resumeGate) this.resumeTails.delete(resumeId);
        releaseJournal?.();
        const pending = this.waiting.get(conversationId);
        if (pending?.includes(controller)) {
          pending.splice(pending.indexOf(controller), 1);
          if (pending.length === 0) this.waiting.delete(conversationId);
        }
        this.emitActivity(conversationId, sessionId,
          this.waiting.has(conversationId) ? 'queued' : 'idle', turnClass);
      }
    });
    this.queues.set(conversationId, next);
    void next.then(() => { if (this.queues.get(conversationId) === next) this.queues.delete(conversationId); },
      () => { if (this.queues.get(conversationId) === next) this.queues.delete(conversationId); });
    return next;
  }

  // ── claude -p invocation ─────────────────────────────────────────────────

  private async invokeClaude(
    prompt: string,
    systemPromptPath: string,
    mcpConfigPath: string,
    resumeId: string | null,
    conversationId: string,
    onToolCall?: (call: { name: string; input: Record<string, unknown> }) => void,
    /**
     * E30 — fired exactly once, the moment a delivery tool call
     * (`reply`/`send_message`) is first seen in the stream, *before* the
     * child process necessarily exits. Callers may observe delivery, while
     * conversation ownership remains held until child exit.
     */
    onDelivered?: () => void,
    /**
     * E30 — fired exactly once, as soon as the claude session id is first
     * seen in the stream (the earliest event, well before delivery). Lets
     * `runClaudeTurn` persist it to the DB immediately instead of waiting
     * for the process to close, so queued work and activity observers can
     * learn the session identity promptly.
     */
    onSessionId?: (id: string) => void,
    opts?: { db?: Database.Database; scheduleModel?: string | null; agentId?: string | null },
  ): Promise<SpawnResult> {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose', // required by the CLI when --print is combined with --output-format=stream-json
      // "all" is treated as a tool name, not a wildcard. Delivery must be
      // explicitly allowed because this is a noninteractive Claude process.
      '--allowedTools', 'mcp__agentbus__reply,mcp__agentbus__send_message',
      '--mcp-config', mcpConfigPath,
      '--system-prompt-file', systemPromptPath,
    ];

    // Resolve model: the fired schedule's own model, then an agent/global
    // override, then this instance's configured model. See
    // src/adapters/model-override-loader.ts and docs/CC_HEADLESS_ADAPTER.md.
    const { model, source } = resolveModel({
      scheduleModel: opts?.scheduleModel,
      db: opts?.db,
      agentId: opts?.agentId,
      configModel: this.cfg.model,
    });
    console.error(`[${this.label}] Resolved model: ${model ?? '(cli default)'} (source=${source})`);

    if (model) {
      args.push('--model', model);
    }
    if (resumeId) {
      args.push('--resume', resumeId);
    }

    const trackingId = conversationId;

    return new Promise((resolvePromise) => {
      // cwd drives which CLAUDE.md hierarchy claude -p auto-loads into context.
      // CLAUDE_CODE_DISABLE_AUTO_MEMORY: the adapter already injects the agent's
      // memory files via {{memories}} in the system prompt, so the CLI's native
      // auto-memory feature would load MEMORY.md a second time. Disable it here so
      // every headless agent avoids the double-load without per-agent config.
      const child = spawn(this.cfg.claude_bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workingDir,
        // Claude may pass its own process environment through to MCP children
        // ahead of the per-server env block. Keep these absolute and scoped to
        // this headless instance so cc.ts does not look for config.yaml in the
        // agent's working directory or fall back to the wrong agent.
        env: {
          ...process.env,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          AGENTBUS_CONFIG: configPath,
          AGENTBUS_AGENT_ID: this.cfg.agent_id,
          AGENTBUS_TOOLS_ONLY: 'true',
        },
      });
      this.activeChildren.set(trackingId, child);

      let claudeSessionId: string | null = null;
      let resultText: string | null = null;
      let deliveredViaTool = false;
      const pendingDeliveryIds = new Set<string>();
      let completedDelivery = false;
      let errorOutput = '';
      let spawnError: string | null = null;
      let totalCostUsd: number | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let numTurns: number | null = null;

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
            message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown }> };
            /** E39 — only present on the terminal `result` event. */
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number };
            num_turns?: number;
          };

          if (event.session_id && !claudeSessionId) {
            claudeSessionId = event.session_id;
            onSessionId?.(event.session_id);
          }

          // Watch assistant turns for tool calls: reply/send_message means the
          // agent delivers via a tool (the adapter must NOT also post stdout);
          // every other tool call is surfaced via onToolCall for E29's live
          // status stream (a no-op when no callback is registered) — but only
          // up to the point of delivery. The agent can keep working after
          // calling reply/send_message; once delivered, further tool calls
          // must not reopen the status trail the user already saw replaced
          // by their answer.
          const wasDelivered = deliveredViaTool;
          const { reportable, delivered } = selectReportableCalls(extractToolCalls(event), deliveredViaTool);
          deliveredViaTool = delivered;
          if (event.type === 'assistant') {
            for (const block of event.message?.content ?? []) {
              if (block.type === 'tool_use' && block.id && block.name && DELIVERY_TOOL_NAMES.has(block.name)) {
                pendingDeliveryIds.add(block.id);
              }
            }
          }
          if (event.type === 'user') {
            for (const block of event.message?.content ?? []) {
              if (block.type !== 'tool_result' || !block.tool_use_id || !pendingDeliveryIds.delete(block.tool_use_id)) continue;
              if (block.is_error) {
                console.error(`[${this.label}] delivery tool failed: ${String(block.content).slice(0, ERROR_DETAIL_MAX_LENGTH)}`);
                if (!completedDelivery && pendingDeliveryIds.size === 0) deliveredViaTool = false;
              } else if (!block.is_error) {
                completedDelivery = true;
              }
            }
          }
          for (const call of reportable) {
            onToolCall?.({ name: call.name, input: call.input });
          }
          // E30: fire the early-unblock signal on the transition to delivered,
          // not on every subsequent event once already delivered.
          if (!wasDelivered && deliveredViaTool) {
            onDelivered?.();
          }

          if (event.type === 'result') {
            if (event.is_error) {
              spawnError = `claude reported error: ${event.result ?? 'unknown'}`;
            } else {
              resultText = event.result ?? null;
            }
            // Always capture final session_id from result event
            if (event.session_id) claudeSessionId = event.session_id;
            // E39: capture cost/usage regardless of is_error — an errored
            // result event still typically carries partial cost data for the
            // tokens actually spent.
            if (typeof event.total_cost_usd === 'number') totalCostUsd = event.total_cost_usd;
            if (typeof event.usage?.input_tokens === 'number') inputTokens = event.usage.input_tokens;
            if (typeof event.usage?.output_tokens === 'number') outputTokens = event.usage.output_tokens;
            if (typeof event.num_turns === 'number') numTurns = event.num_turns;
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
        if (this.activeChildren.get(trackingId) === child) this.activeChildren.delete(trackingId);
        const wasStopped = this.stoppedByUser.delete(trackingId);

        if (wasStopped) {
          resolvePromise({
            claudeSessionId, resultText: null, deliveredViaTool, error: null, stoppedByUser: true,
            totalCostUsd, inputTokens, outputTokens, numTurns,
          });
        } else if (spawnError) {
          resolvePromise({
            claudeSessionId, resultText: null, deliveredViaTool, error: spawnError, stoppedByUser: false,
            totalCostUsd, inputTokens, outputTokens, numTurns,
          });
        } else if (code !== 0 && resultText === null) {
          const detail = errorOutput.slice(-500).trim() || `exit code ${code}`;
          resolvePromise({
            claudeSessionId, resultText: null, deliveredViaTool, error: detail, stoppedByUser: false,
            totalCostUsd, inputTokens, outputTokens, numTurns,
          });
        } else {
          resolvePromise({
            claudeSessionId, resultText, deliveredViaTool, error: null, stoppedByUser: false,
            totalCostUsd, inputTokens, outputTokens, numTurns,
          });
        }
      });
    });
  }

  // ── Outbound delivery ────────────────────────────────────────────────────

  /**
   * Tell the source adapter to start its typing indicator while claude -p runs.
   * Fire-and-forget — no-ops server-side for channels without typing capability.
   * Email channels have no typing indicator, so skip the call entirely. `topic`
   * (E28) further targets a specific Telegram forum topic within a group.
   */
  private startTyping(channel: string, contactId: string, topic?: string, conversationId?: string): void {
    if (channel === 'email' || channel.startsWith('email:')) return;
    fetch(`${this.busBaseUrl}/api/v1/adapters/${channel}/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_id: contactId, topic, conversation_id: conversationId }),
    }).catch(() => {});
  }

  /**
   * Report a formatted tool-call status line to the source adapter (E29).
   * Fire-and-forget — no-ops server-side for adapters without the
   * `toolStatus` capability. Email channels have no equivalent primitive, so
   * skip the call entirely, matching startTyping's existing email skip.
   * `topic` (E28) further targets a specific Telegram forum topic.
   */
  private reportToolCall(channel: string, contactId: string, text: string, topic?: string, conversationId?: string): void {
    if (channel === 'email' || channel.startsWith('email:')) return;
    fetch(`${this.busBaseUrl}/api/v1/adapters/${channel}/tool-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_id: contactId, text, topic, conversation_id: conversationId }),
    }).catch(() => {});
  }

  /**
   * Kill the in-flight `claude -p` turn for `conversationId`, if one is running
   * (`/stop`). Marks the conversation as user-stopped first so the turn's own
   * close handler resolves with `stoppedByUser: true` instead of treating
   * the kill as a crash needing an error reply.
   *
   * Uses SIGKILL, not SIGTERM: `claude`'s own interrupt handling treats a
   * catchable signal as "wrap up gracefully," which in practice re-prompted
   * itself with a bare "Continue from where you left off" instead of
   * actually stopping — the opposite of what `/stop` is for. SIGKILL cannot
   * be caught, so the whole turn dies outright and the user, not the agent,
   * decides what happens next.
   */
  stopTurn(conversationId: string): boolean {
    const child = this.activeChildren.get(conversationId);
    if (child) {
      this.stoppedByUser.add(conversationId);
      child.kill('SIGKILL');
      return true;
    }
    const waiting = this.waiting.get(conversationId);
    if (!waiting?.length) return false;
    waiting[0]!.abort();
    return true;
  }

  private async deliverResponse(original: MessageEnvelope, resultText: string): Promise<void> {
    const body = {
      channel: original.channel,
      topic: original.topic,
      sender: this.agentId,
      recipient: original.sender,
      reply_to: original.id,
      priority: 'normal',
      payload: { type: 'text', body: resultText },
      metadata: {},
    };

    const res = await fetch(`${this.busBaseUrl}/api/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`Bus rejected outbound: ${data.error ?? `HTTP ${res.status}`}`);
    }
  }

  /** Builds the failure message delivered to the user, appending the raw error detail when `error_passthrough` is enabled. */
  private buildErrorReply(detail: string): string {
    if (!this.cfg.error_passthrough) return this.cfg.error_reply;
    const truncated =
      detail.length > ERROR_DETAIL_MAX_LENGTH ? `${detail.slice(0, ERROR_DETAIL_MAX_LENGTH)}…` : detail;
    return `${this.cfg.error_reply}\n\nDetails: ${truncated}`;
  }

  // ── Turn runner (shared by normal + journaling turns) ───────────────────

  /**
   * Render the system prompt, write temp files, invoke claude -p, and persist any
   * new claude_session_id. Shared by normal turns (processBatch) and silent
   * journaling turns (runJournalingTurn). The memory context block is assembled
   * fresh from the agent's files on every call.
   */
  private async runClaudeTurn(opts: {
    db: Database.Database;
    session: SessionRow | null;
    contactId: string;
    conversationId: string;
    channel: string;
    prompt: string;
    resumeId: string | null;
    onToolCall?: (call: { name: string; input: Record<string, unknown> }) => void;
    /** E30 — see `invokeClaude`'s `onDelivered` param. */
    onDelivered?: () => void;
    /**
     * E53 — the fired schedule's own model, stamped by the scheduler as
     * `metadata.schedule_model` on the first envelope of the batch. Takes
     * priority over any agent/global override or this instance's configured
     * model. See `resolveModel` in model-override-loader.ts.
     */
    scheduleModel?: string | null;
  }): Promise<SpawnResult> {
    const now = new Date();

    // Context-block ledger (migration 017 / src/adapters/context-ledger.ts):
    // only meaningful when there's a real, resumable session to track it
    // against — mirrors the `!opts.session` guard `persistSessionId` uses
    // below. `opts.session` is null for /clear's journalResumeId (the DB
    // session row is already closed), so that path keeps sending the full,
    // unfiltered memory context every time via the fallback below.
    let promptForClaude = opts.prompt;
    let blocksSentThisTurn: Array<{ key: string; hash: string }> = [];

    if (opts.session) {
      // Sharp input-token drop since the last turn: Claude Code's own
      // auto-compaction likely summarized the resumed transcript, so the
      // ledger's record of "this session already has block X in context" no
      // longer holds. Wipe it and resend everything fresh.
      if (detectCompaction(opts.db, opts.session.id)) {
        clearLedger(opts.db, opts.session.id);
      }

      const hashedBlocks = assembleMemoryBlocks(this.workingDir, this.cfg.memory, now).map((b) => ({
        block: b,
        hash: hashBlock(b.content),
      }));
      const newBlocks = hashedBlocks.filter(({ block, hash }) =>
        shouldSendBlock(opts.db, opts.session!.id, block.key, hash),
      );

      if (newBlocks.length > 0) {
        const prefix = newBlocks.map(({ block }) => `=== ${block.label} ===\n${block.content}`).join('\n\n');
        promptForClaude = `${prefix}\n\n${opts.prompt}`;
      }
      blocksSentThisTurn = newBlocks.map(({ block, hash }) => ({ key: block.key, hash }));
    }

    const ctx: PromptContext = {
      contact_id: opts.contactId,
      channel: opts.channel,
      date: formatLocalDate(now),
      // The ledger above (when opts.session is set) now carries memory
      // content into the user turn instead of the system prompt, so the
      // system prompt stays a frozen cache prefix across turns — mirroring
      // what src/pool/pane.ts's renderAndWriteSystemPrompt already does for
      // pool sessions (memories: '' there too), just for a different reason:
      // pool sessions rely on native CLAUDE.md auto-loading, while headless
      // turns get their memory content from the ledger-filtered prefix on
      // `promptForClaude` instead. When there's no session to track a ledger
      // against, fall back to the old behavior of inlining the full context
      // via {{memories}}.
      memories: opts.session ? '' : assembleMemoryContext(this.workingDir, this.cfg.memory, now),
      // E20: structured DB summaries are retired; files are the source of truth.
      session_summary: '',
      agent_id: this.agentId,
    };

    // Render {{vars}} then expand @path file references (trusted operator config).
    const systemPromptText = expandFileReferences(
      renderSystemPrompt(this.cfg.system_prompt, ctx),
      this.workingDir,
    );

    const spPath = writeTmp(systemPromptText, '.txt');
    const mcpPath = writeTmp(JSON.stringify(buildMcpConfig(this.cfg.agent_id)), '.json');

    // Persist claude_session_id as soon as known so session observers have it
    // before child exit. The final write below is idempotent.
    const persistSessionId = (id: string): void => {
      if (!opts.session) return;
      try {
        storeClaudeSessionId(opts.db, opts.session.id, id);
      } catch (err) {
        console.error(`[${this.label}] Failed to store claude_session_id for ${opts.session.id}:`, err);
      }
    };

    // E39: persist the turn's cost, if the result event carried one. Skipped
    // entirely (not written as a fabricated 0) when totalCostUsd is null.
    const recordCost = (result: SpawnResult): void => {
      if (result.totalCostUsd === null) return;
      try {
        recordTurnCost(opts.db, {
          agentId: this.agentId,
          sessionId: opts.session?.id ?? null,
          costUsd: result.totalCostUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          numTurns: result.numTurns,
        });
      } catch (err) {
        console.error(`[${this.label}] Failed to record turn cost:`, err);
      }
    };

    try {
      const result = await this.invokeClaude(
        promptForClaude,
        spPath,
        mcpPath,
        opts.resumeId,
        opts.conversationId,
        opts.onToolCall,
        opts.onDelivered,
        persistSessionId,
        {
          db: opts.db,
          agentId: this.agentId,
          scheduleModel: opts.scheduleModel,
        },
      );
      // Final persist covers the case where the session id changed (rare) or
      // was only captured on the closing `result` event.
      if (result.claudeSessionId) {
        persistSessionId(result.claudeSessionId);
      }
      recordCost(result);
      // Ledger update, same success path as persistSessionId/recordCost
      // above: only now that the turn actually completed do the blocks we
      // prepended to promptForClaude count as "sent" — a failed/errored
      // invokeClaude call must not mark them sent, since claude may never
      // have actually received them.
      if (opts.session) {
        for (const { key, hash } of blocksSentThisTurn) {
          markBlockSent(opts.db, opts.session.id, key, hash);
        }
      }
      return result;
    } finally {
      cleanTmp(spPath, mcpPath);
    }
  }

  // ── Batch processor ──────────────────────────────────────────────────────

  private async processBatch(envelopes: MessageEnvelope[], db: Database.Database, conversationId: string): Promise<void> {
    const first = envelopes[0]!;
    const contactId = first.sender; // contact:alice after pipeline resolution
    const channel = first.channel;
    const topic = first.topic;

    // Show activity on the source channel (and forum topic, if any — E28)
    // while the (cold-start) claude -p runs.
    this.startTyping(channel, contactId, topic, conversationId);

    // E20: key resume on conversation_id (per-thread sessions, long-lived).
    const session = getActiveSession(db, conversationId);
    const resumeId = session?.claude_session_id ?? null;

    // Memory is injected via the system prompt (assembleMemoryContext), so suppress
    // the Stage-85 <memory> block in the user message to avoid double injection.
    const prompt = formatMessagesForSampling(envelopes, { includeMemoryContext: false });

    // E53: the scheduler stamps metadata.schedule_model on the fired envelope
    // when the schedule that triggered this batch has its own `model`. Only
    // a non-empty string counts — anything else falls through to an agent/
    // global override or this instance's configured model.
    const rawScheduleModel = first.metadata?.['schedule_model'];
    const scheduleModel = typeof rawScheduleModel === 'string' && rawScheduleModel.trim().length > 0 ? rawScheduleModel : undefined;

    // Delivery can happen before child exit. Keep conversation ownership until
    // both exit and fallback delivery settle, so no two children ever resume
    // the same claude session concurrently.
    const { resultText, deliveredViaTool, error, stoppedByUser } = await this.runClaudeTurn({
      db,
      session,
      contactId,
      conversationId,
      channel,
      prompt,
      resumeId,
      onToolCall: (call) =>
        this.reportToolCall(channel, contactId, formatToolCallSummary(call.name, call.input), topic, conversationId),
      scheduleModel,
    });
    if (stoppedByUser) return;
    if (deliveredViaTool) {
      if (error) console.error(`[${this.label}] claude reported an error for ${conversationId.slice(0, 8)} after delivery: ${error}`);
      return;
    }
    if (error || !resultText) {
      const detail = error ?? 'no result';
      console.error(`[${this.label}] claude invocation failed for ${conversationId.slice(0, 8)}: ${detail}`);
      await this.deliverResponse(first, this.buildErrorReply(detail));
      return;
    }
    await this.deliverResponse(first, resultText);
  }

  // ── Silent journaling turn (E20) ─────────────────────────────────────────

  /**
   * Fire a silent `--resume` journaling turn for a paused conversation: the agent
   * reviews the conversation and updates its own memory files. Nothing is
   * delivered to the user (no deliverResponse, no stdout fallback, no typing
   * indicator). Serialized through the same conversation queue as normal turns so
   * a journaling turn never races a live reply on the same claude_session_id.
   *
   * Resolves `{ skipped: true }` when the session has no claude_session_id yet
   * (the agent never spoke — nothing to journal); the dispatcher stamps it
   * journaled anyway. Rejects on invocation error so the dispatcher leaves
   * last_journaled_at unchanged and retries on a later tick.
   */
  runJournalingTurn(conversationId: string, db: Database.Database): Promise<{ skipped?: boolean }> {
    const session = getActiveSession(db, conversationId);
    if (!session || !session.claude_session_id) {
      return Promise.resolve({ skipped: true });
    }

    return new Promise((resolvePromise, rejectPromise) => {
      void this.enqueue(conversationId, session.id, 'system', true, async () => {
        const result = await this.runClaudeTurn({
          db,
          session,
          contactId: session.contact_id,
          conversationId,
          channel: session.channel,
          prompt: this.cfg.journaling.prompt,
          resumeId: session.claude_session_id,
        });
        // Silent: never deliver. Any reply/send_message the agent chose to call
        // already went through the MCP tool — the adapter posts nothing here.
        if (result.error) {
          rejectPromise(new Error(result.error));
          return;
        }
        resolvePromise({});
      }, session.claude_session_id).catch(rejectPromise);
    });
  }

  /**
   * Fire a silent background journaling turn for an explicit claude session id,
   * independent of the DB session row. Used by the `/clear` command: the bus has
   * already set `ended_at` on the session (so the next message starts fresh), but
   * the underlying claude session still exists on disk and can be resumed for one
   * final memory pass. Serialized through the same conversation queue so it never
   * races a live turn. Failures are logged, not surfaced — journaling is silent.
   */
  journalResumeId(db: Database.Database, opts: { claudeSessionId: string; contactId: string; channel: string; conversationId?: string }): void {
    const conversationId = opts.conversationId ?? `journal:${opts.claudeSessionId}`;
    void this.enqueue(conversationId, undefined, 'system', true, async () => {
      try {
        const result = await this.runClaudeTurn({
          db,
          session: null, // session already closed; nothing to persist back
          contactId: opts.contactId,
          conversationId,
          channel: opts.channel,
          prompt: this.cfg.journaling.prompt,
          resumeId: opts.claudeSessionId,
        });
        if (result.error) {
          console.error(`[${this.label}] /clear journaling failed for ${opts.contactId}: ${result.error}`);
        }
      } catch (err) {
        console.error(`[${this.label}] /clear journaling threw for ${opts.contactId}:`, err);
      }
    }, opts.claudeSessionId).catch((error: unknown) => console.error(`[${this.label}] /clear journaling queue failed:`, error));
  }

  // ── Poll loop ─────────────────────────────────────────────────────────────

  private async poll(db: Database.Database): Promise<void> {
    if (this.shuttingDown) return;

    try {
      const res = await fetch(
        `${this.busBaseUrl}/api/v1/messages/pending?agent=${this.cfg.agent_id}&limit=20`,
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as {
        ok: boolean;
        messages: MessageEnvelope[];
      };

      // Ack all messages upfront, then group survivors by sender
      const ackResults = await Promise.all(
        data.messages.map(async (env): Promise<MessageEnvelope | null> => {
          try {
            const ackRes = await fetch(`${this.busBaseUrl}/api/v1/messages/${env.id}/ack`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'delivered' }),
            });
            if (ackRes.ok) return env;
            else console.error(`[${this.label}] ack rejected for ${env.id}: HTTP ${ackRes.status}`);
          } catch (err) {
            console.error(`[${this.label}] ack failed for ${env.id}:`, err);
          }
          return null;
        }),
      );
      const acked = ackResults.filter((env): env is MessageEnvelope => env !== null);

      // Group by logical conversation, preserving dequeue order within it.
      const byConversation = new Map<string, MessageEnvelope[]>();
      for (const env of acked) {
        const conversationId = resolveConversationId(db, env);
        const group = byConversation.get(conversationId) ?? [];
        group.push(env);
        byConversation.set(conversationId, group);
      }

      for (const [conversationId, batch] of byConversation) {
        const batchCopy = [...batch];
        const session = getActiveSession(db, conversationId);
        const system = batchCopy.every((env) => env.metadata?.['scheduled'] === true || env.sender.startsWith('system:'));
        void this.enqueue(conversationId, session?.id, system ? 'system' : 'user', false,
          () => this.processBatch(batchCopy, db, conversationId), session?.claude_session_id);
      }
    } catch (err) {
      console.error(`[${this.label}] Poll error:`, err);
    }

    if (!this.shuttingDown) {
      this.pollTimer = setTimeout(() => void this.poll(db), this.cfg.poll_interval_ms);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(db: Database.Database): HeadlessHandle {
    console.log(`[${this.label}] Starting — polling ${this.busBaseUrl} for ${this.agentId} every ${this.cfg.poll_interval_ms}ms`);
    void this.poll(db);
    return {
      runJournalingTurn: (conversationId: string) => this.runJournalingTurn(conversationId, db),
      journalResumeId: (opts) => this.journalResumeId(db, opts),
      stopTurn: (conversationId: string) => this.stopTurn(conversationId),
      subscribeActivity: (listener) => this.subscribeActivity(listener),
      snapshot: () => this.snapshot(),
    };
  }

  stop(): void {
    this.shuttingDown = true;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
  }
}

// ── Lifecycle (multi-instance) ────────────────────────────────────────────────

const instances = new Map<string, HeadlessInstance>();

/**
 * Start every configured `cc-headless` instance as part of the in-process bus.
 * Each entry in `getCcHeadlessInstances(config)` (legacy single-instance or
 * named record) gets its own `HeadlessInstance` with isolated state — poll
 * loop, per-conversation queue, claude -p invocation.
 *
 * Returns a map of `HeadlessHandle`s keyed by `agent:<agent_id>` the
 * SessionTracker uses to dispatch journaling turns to the right instance, or
 * an empty map when no `cc-headless` config is present.
 */
export function startHeadless(db: Database.Database): Map<string, HeadlessHandle> {
  const handles = new Map<string, HeadlessHandle>();
  const configs = getCcHeadlessInstances(config);
  if (configs.length === 0) {
    console.warn('[cc-headless] No cc-headless adapter config found — skipping');
    return handles;
  }

  const busBaseUrl = `http://127.0.0.1:${config.bus.http_port}`;
  for (const instCfg of configs) {
    const instance = new HeadlessInstance(instCfg, busBaseUrl);
    instances.set(`agent:${instCfg.agent_id}`, instance);
    handles.set(`agent:${instCfg.agent_id}`, instance.start(db));
  }
  return handles;
}

export function stopHeadless(): void {
  for (const instance of instances.values()) instance.stop();
  instances.clear();
}

/** Current per-instance capacity for /status, health, and app reconnects. */
export function getHeadlessSnapshots(): HeadlessCapacitySnapshot[] {
  return [...instances.values()].map((instance) => instance.snapshot());
}
