/**
 * Script journaler (E66 S66.7): run a user-provided executable with the
 * journal job as JSON on stdin. The contract (docs/JOURNALING.md#script-journaler):
 *
 *   - Executed directly, no shell. `command` is absolute or resolved against
 *     the agent's working dir; cwd is the working dir.
 *   - Minimal environment: PATH, HOME, the AGENTBUS_* variables below, plus
 *     the configured `env`. Nothing else from the bus (no secrets).
 *   - stdin: `ScriptPayloadV1` (`version: 1`).
 *   - Exit codes: 0 done, 3 nothing-to-do, 75 unavailable, anything else
 *     (or a timeout) failed-after-start. A command that can't be started is
 *     failed-before-start.
 *   - Optional stdout JSON `{ files_changed?, notes?, cost_usd? }`. stderr is
 *     captured (truncated) to the bus log and, on failure, the run's error.
 *   - Timeout (`script.timeout_ms`, default the journaling timeout): SIGTERM,
 *     then SIGKILL, to the process group. The chain runner's abort does the same.
 *
 * Message bodies, file names and snapshots in the payload are untrusted
 * data: scripts must never execute them.
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { runProcess as defaultRunProcess, tail, type RunProcessOptions, type RunProcessResult } from '../process.js';
import type { Journaler, JournalAvailability, JournalJob, JournalRunContext, JournalRunResult } from '../types.js';

/** Exit codes of the script contract. */
export const SCRIPT_EXIT = { done: 0, nothingToDo: 3, unavailable: 75 } as const;

/** Version of the stdin payload. Bump on incompatible changes. */
export const SCRIPT_PAYLOAD_VERSION = 1;

export interface ScriptPayloadV1 {
  version: 1;
  kind: JournalJob['kind'];
  run_id: string;
  trigger: string;
  agent_id: string;
  /** The id the session is attributed to: a pane id for cc-pool, else = agent_id. */
  session_agent_id: string;
  runtime: string;
  working_dir: string | null;
  memory_dir: string | null;
  conversation_id: string;
  session_id: string;
  claude_session_id: string | null;
  harness_session_id: string | null;
  harness_transcript_path: string | null;
  channel: string;
  contact_id: string;
  topic: string | null;
  session_open: boolean;
  window: { cursor_at: string | null; from: string | null; to: string | null };
  human_message_count: number;
  messages: Array<{
    id: string;
    message_id: string;
    created_at: string;
    direction: 'inbound' | 'outbound';
    author: { id: string; is_human: boolean; is_owner: boolean; is_agent: boolean };
    body: string;
    attachments: Array<{ type: string; path: string; mime_type?: string; filename?: string }>;
    scheduled: boolean;
    /** True for the agent message before the first new human message, included as context. */
    context: boolean;
  }>;
  snapshots: Array<{ id: string; event: string; path: string; created_at: string }>;
  prompt: string;
  model: string | null;
  timeout_ms: number;
  /**
   * E68 — present on `kind: "consolidate"` payloads only (session fields are
   * empty strings and `messages` is empty there). `prompt` is the full
   * consolidation instruction with these values written out.
   */
  consolidation?: {
    last_pass_at: string | null;
    session_runs_since: number;
    index_path: string | null;
    daily_dir: string | null;
    archive_dir: string | null;
    archive_before: string;
    max_memory_lines: number;
    max_memory_bytes: number;
  };
}

export function buildScriptPayload(job: JournalJob): ScriptPayloadV1 {
  const script = job.settings.journalers.script;
  return {
    version: 1,
    kind: job.kind,
    run_id: job.runId,
    trigger: job.trigger,
    agent_id: job.agentId,
    session_agent_id: job.sessionAgentId,
    runtime: job.runtime,
    working_dir: job.workingDir,
    memory_dir: job.memoryDir,
    conversation_id: job.conversationId,
    session_id: job.sessionId,
    claude_session_id: job.claudeSessionId,
    harness_session_id: job.harnessSessionId,
    harness_transcript_path: job.harnessTranscriptPath,
    channel: job.channel,
    contact_id: job.contactId,
    topic: job.topic,
    session_open: job.sessionOpen,
    window: { cursor_at: job.window.cursorAt, from: job.window.from, to: job.window.to },
    human_message_count: job.humanMessageCount,
    messages: job.messages.map((m) => ({
      id: m.id,
      message_id: m.message_id,
      created_at: m.created_at,
      direction: m.direction,
      author: { ...m.author },
      body: m.body,
      attachments: m.attachments.map((a) => ({ ...a })),
      scheduled: m.scheduled,
      context: m.context,
    })),
    snapshots: job.snapshots.map((s) => ({ ...s })),
    prompt: job.prompt,
    model: script?.model ?? job.model,
    timeout_ms: script?.timeoutMs ?? job.timeoutMs,
    ...(job.consolidation
      ? {
          consolidation: {
            last_pass_at: job.consolidation.lastPassAt,
            session_runs_since: job.consolidation.sessionRunsSince,
            index_path: job.consolidation.indexPath,
            daily_dir: job.consolidation.dailyDir,
            archive_dir: job.consolidation.archiveDir,
            archive_before: job.consolidation.archiveBefore,
            max_memory_lines: job.consolidation.maxMemoryLines,
            max_memory_bytes: job.consolidation.maxMemoryBytes,
          },
        }
      : {}),
  };
}

/** Parse the optional stdout JSON (the last JSON object printed). */
export function parseScriptOutput(stdout: string): { filesChanged?: string[]; notes?: string; costUsd?: number } | null {
  const text = stdout.trim();
  if (!text) return null;
  for (const candidate of [text, ...text.split('\n').reverse()]) {
    try {
      const v = JSON.parse(candidate) as Record<string, unknown>;
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const files = Array.isArray(v['files_changed']) ? v['files_changed'].filter((f): f is string => typeof f === 'string') : undefined;
      return {
        ...(files ? { filesChanged: files } : {}),
        ...(typeof v['notes'] === 'string' ? { notes: tail(v['notes'], 2000) } : {}),
        ...(typeof v['cost_usd'] === 'number' ? { costUsd: v['cost_usd'] } : {}),
      };
    } catch {
      // not this line
    }
  }
  return null;
}

export interface ScriptJournalerDeps {
  /** Bus base URL, passed as AGENTBUS_URL. */
  busUrl?: string;
  /** PATH / HOME given to scripts. Default: the bus's own PATH and HOME. */
  basePath?: string;
  home?: string;
  runProcess?: (opts: RunProcessOptions) => Promise<RunProcessResult>;
  log?: (line: string) => void;
}

const STDERR_LOG = 2000;
const STDERR_ERROR = 400;

export class ScriptJournaler implements Journaler {
  readonly id = 'script' as const;
  readonly requires = [] as const;
  readonly supportsKinds = ['session', 'consolidate'] as const;
  private readonly run_: (opts: RunProcessOptions) => Promise<RunProcessResult>;

  constructor(private readonly deps: ScriptJournalerDeps = {}) {
    this.run_ = deps.runProcess ?? defaultRunProcess;
  }

  private cwd(job: JournalJob): string {
    return job.workingDir ?? this.deps.home ?? homedir();
  }

  /** The executable, resolved against the working dir when relative. */
  commandPath(job: JournalJob): string | null {
    const script = job.settings.journalers.script;
    if (!script) return null;
    return isAbsolute(script.command) ? script.command : resolvePath(this.cwd(job), script.command);
  }

  canJournal(job: JournalJob): JournalAvailability {
    const command = this.commandPath(job);
    if (!command) return { ok: false, reason: 'journaling.script.command is not set' };
    try {
      if (!statSync(command).isFile()) return { ok: false, reason: `${command} is not a file` };
      accessSync(command, fsConstants.X_OK);
    } catch (err) {
      return { ok: false, reason: `${command} is not executable: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true };
  }

  /** The script's whole environment. */
  environment(job: JournalJob): Record<string, string> {
    const script = job.settings.journalers.script;
    const payload = buildScriptPayload(job);
    const env: Record<string, string> = {
      PATH: this.deps.basePath ?? process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: this.deps.home ?? process.env['HOME'] ?? homedir(),
      AGENTBUS_PAYLOAD_VERSION: String(SCRIPT_PAYLOAD_VERSION),
      AGENTBUS_RUN_ID: job.runId,
      AGENTBUS_AGENT_ID: job.agentId,
      AGENTBUS_TRIGGER: job.trigger,
      AGENTBUS_JOB_KIND: job.kind,
      AGENTBUS_CONVERSATION_ID: job.conversationId,
      AGENTBUS_SESSION_ID: job.sessionId,
      AGENTBUS_MEMORY_DIR: job.memoryDir ?? '',
      AGENTBUS_WORKING_DIR: job.workingDir ?? '',
      ...(payload.model ? { AGENTBUS_MODEL: payload.model } : {}),
      ...(this.deps.busUrl ? { AGENTBUS_URL: this.deps.busUrl } : {}),
    };
    return { ...env, ...(script?.env ?? {}) };
  }

  async run(job: JournalJob, ctx?: JournalRunContext): Promise<JournalRunResult> {
    const script = job.settings.journalers.script;
    const command = this.commandPath(job);
    if (!script || !command) return { outcome: 'unavailable', error: 'journaling.script.command is not set' };
    const payload = buildScriptPayload(job);
    const fidelity = job.snapshots.length > 0 ? 'snapshot' as const : 'bus-transcript' as const;
    const proc = await this.run_({
      command,
      args: script.args,
      cwd: this.cwd(job),
      env: this.environment(job),
      stdin: JSON.stringify(payload),
      timeoutMs: payload.timeout_ms,
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
    });

    const stderr = tail(proc.stderr, STDERR_LOG);
    if (stderr) (this.deps.log ?? ((l: string) => console.log(l)))(`[journaling] script ${command} (run ${job.runId.slice(0, 8)}) stderr: ${stderr}`);

    if (proc.spawnError) return { outcome: 'failed-before-start', error: `could not start ${command}: ${proc.spawnError}`, fidelity };
    if (proc.timedOut || proc.aborted) {
      return {
        outcome: 'failed-after-start', fidelity,
        error: proc.aborted ? 'script aborted; process group killed' : `script timed out after ${payload.timeout_ms} ms; process group killed`,
      };
    }
    const out = parseScriptOutput(proc.stdout) ?? {};
    const extra = {
      fidelity,
      ...(out.filesChanged ? { filesChanged: out.filesChanged } : {}),
      ...(out.notes ? { notes: out.notes } : {}),
      ...(out.costUsd !== undefined ? { costUsd: out.costUsd } : {}),
    };
    switch (proc.code) {
      case SCRIPT_EXIT.done: return { outcome: 'done', ...extra };
      case SCRIPT_EXIT.nothingToDo: return { outcome: 'nothing-to-do', ...extra };
      case SCRIPT_EXIT.unavailable: return { outcome: 'unavailable', error: tail(proc.stderr, STDERR_ERROR) || 'script reported unavailable (exit 75)' };
      default: {
        const how = proc.code === null ? `killed by ${proc.signal ?? 'a signal'}` : `exit ${proc.code}`;
        const detail = tail(proc.stderr, STDERR_ERROR);
        return { outcome: 'failed-after-start', error: detail ? `${how}: ${detail}` : how, ...extra };
      }
    }
  }
}
