/**
 * Protected paths (E68 S68.4): the agent's instructions, which it may not
 * edit itself. See docs/AGENT_LEARNING.md#protected-paths.
 *
 *   - Config: `agents.<id>.protected_paths` (relative to the working dir, or
 *     absolute; directories end in `/`). Default: `CLAUDE.md`, the files the
 *     runtime's `system_prompt` imports with `@path`, `skills/`, `.claude/`.
 *   - The agent's memory dir is never protected, including pinned memory
 *     imported from `CLAUDE.md`.
 *   - Enforcement: cc-headless journaling and consolidation turns deny
 *     edits to these paths (`JournalJob.protectedPaths` → `--disallowedTools`)
 *     and run without Bash (`JOURNAL_TURN_DISALLOWED_TOOLS`), since Claude
 *     Code's `Edit(path)` denies don't cover shell redirects.
 *     For every journaler the chain runner hashes them before and after the
 *     run (`ProtectedPathMonitor`) and raises a `warning` advisory listing
 *     files that changed without an approved proposal (S68.3).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { getCcHeadlessInstances, getCcPoolInstances, type AppConfig } from '../config/schema.js';
import type { AgentRuntime } from '../core/runtime-resolver.js';
import { logicalAgentId, memoryLayout, memorySettingsFor, runtimeWorkingDir } from '../memory/layout.js';

/**
 * Tools every bus-spawned journal and consolidation turn runs without. Bash
 * is denied because `Edit(path)` rules block the Edit and Write tools but not
 * a shell redirect (`echo x >> CLAUDE.md`), verified against the real CLI in
 * the E68 pre-merge spike. These turns only need Read/Edit/Write on memory
 * files. Applied even when the agent has no protected paths. Normal
 * conversation turns keep Bash.
 */
export const JOURNAL_TURN_DISALLOWED_TOOLS: readonly string[] = ['Bash'];

/** Default entries besides the system prompt's imports. */
export const DEFAULT_PROTECTED_PATHS = ['CLAUDE.md', 'skills/', '.claude/'] as const;

/** Files hashed per agent before giving up (a runaway directory). */
const MAX_FILES = 2_000;
/** Files larger than this are compared by size and mtime instead of content. */
const MAX_HASH_BYTES = 5 * 1024 * 1024;

/** Hash of a missing file. */
export const ABSENT = 'absent';

export interface ProtectedEntry {
  /** As configured (or defaulted). */
  spec: string;
  /** Absolute path; directories end in `/`. */
  path: string;
  dir: boolean;
}

export interface ProtectedPaths {
  agentId: string;
  workingDir: string | null;
  memoryDir: string | null;
  entries: ProtectedEntry[];
}

const AGENT_PREFIX = 'agent:';
const toPrefixed = (id: string) => (id.startsWith(AGENT_PREFIX) ? id : `${AGENT_PREFIX}${id}`);

/** `@path` imports in a system prompt template (the syntax `expandFileReferences` expands). */
export function systemPromptImports(template: string | undefined): string[] {
  if (!template) return [];
  const out: string[] = [];
  for (const m of template.matchAll(/(^|\s)@([\w./_-]+)/g)) out.push(m[2]!);
  return [...new Set(out)];
}

/** The system prompt template of an agent's runtime instance, if it has one. */
function systemPromptOf(config: AppConfig, agentId: string): string | undefined {
  const id = toPrefixed(agentId);
  const headless = getCcHeadlessInstances(config).find((i) => toPrefixed(i.agent_id) === id);
  if (headless) return headless.system_prompt;
  return getCcPoolInstances(config).find((i) => toPrefixed(i.agent_id) === id)?.system_prompt;
}

/** Configured (or default) specs for an agent. */
export function protectedSpecs(config: AppConfig, agentId: string): string[] {
  const id = toPrefixed(agentId);
  const configured = Object.entries(config.agents ?? {}).find(([key]) => toPrefixed(key) === id)?.[1]?.protected_paths;
  if (configured) return [...configured];
  return [...new Set([DEFAULT_PROTECTED_PATHS[0], ...systemPromptImports(systemPromptOf(config, id)), ...DEFAULT_PROTECTED_PATHS.slice(1)])];
}

const within = (path: string, dir: string) => {
  const d = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return path === dir || path.startsWith(d);
};

/** Absolute protected entries for an agent (any id form), resolved through its runtime. */
export function resolveProtectedPaths(
  config: AppConfig,
  resolver: { resolve(agentId: string): AgentRuntime | undefined },
  agentId: string,
): ProtectedPaths {
  const runtime = resolver.resolve(toPrefixed(agentId));
  const logical = runtime ? logicalAgentId(runtime) : toPrefixed(agentId);
  const workingDir = runtimeWorkingDir(runtime);
  const memoryDir = memoryLayout(memorySettingsFor(config, logical), workingDir).memoryDir;
  const entries: ProtectedEntry[] = [];
  for (const spec of protectedSpecs(config, logical)) {
    if (!isAbsolute(spec) && !workingDir) continue;
    const dir = spec.endsWith('/');
    const abs = resolvePath(isAbsolute(spec) ? spec : join(workingDir!, spec));
    // The memory dir (and everything in it) stays writable.
    if (memoryDir && within(abs, resolvePath(memoryDir))) continue;
    entries.push({ spec, path: dir ? `${abs}${sep}` : abs, dir });
  }
  return { agentId: logical, workingDir, memoryDir, entries };
}

/** True when `path` (absolute) is one of the protected files or inside a protected directory, and not in the memory dir. */
export function isProtectedPath(paths: ProtectedPaths, path: string): boolean {
  const abs = resolvePath(path);
  if (paths.memoryDir && within(abs, resolvePath(paths.memoryDir))) return false;
  return paths.entries.some((e) => (e.dir ? within(abs, e.path.slice(0, -1)) : abs === e.path));
}

/**
 * Paths for `JournalJob.protectedPaths` (deny rules). A protected directory
 * that contains the memory dir can't be denied as a whole without blocking
 * memory writes, so it is left to the before/after hashing.
 */
export function denyablePaths(paths: ProtectedPaths): string[] {
  const mem = paths.memoryDir ? resolvePath(paths.memoryDir) : null;
  return paths.entries.filter((e) => !(e.dir && mem && within(mem, e.path.slice(0, -1)))).map((e) => e.path);
}

/** Content hash of a file (sha256), `size:mtime` for very large files, or ABSENT. */
export function hashFile(path: string): string {
  try {
    const st = statSync(path);
    if (!st.isFile()) return ABSENT;
    if (st.size > MAX_HASH_BYTES) return `size:${st.size}:${st.mtimeMs}`;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return ABSENT;
  }
}

/** Absolute file path → hash, for every file under the protected entries (memory dir excluded). */
export type ProtectedSnapshot = Map<string, string>;

export function snapshotProtected(paths: ProtectedPaths): ProtectedSnapshot {
  const out: ProtectedSnapshot = new Map();
  const mem = paths.memoryDir ? resolvePath(paths.memoryDir) : null;
  const walk = (dir: string) => {
    if (out.size >= MAX_FILES || (mem && within(dir, mem))) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= MAX_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !(mem && within(full, mem))) out.set(full, hashFile(full));
    }
  };
  for (const e of paths.entries) {
    if (e.dir) walk(e.path.slice(0, -1));
    else {
      const h = hashFile(e.path);
      if (h !== ABSENT) out.set(e.path, h);
    }
  }
  return out;
}

/** Files added, changed or removed between two snapshots, sorted. */
export function diffProtected(before: ProtectedSnapshot, after: ProtectedSnapshot): Array<{ path: string; hash: string }> {
  const changed = new Map<string, string>();
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.set(path, hash);
  for (const path of before.keys()) if (!after.has(path)) changed.set(path, ABSENT);
  return [...changed.entries()].map(([path, hash]) => ({ path, hash })).sort((a, b) => a.path.localeCompare(b.path));
}

/** A path relative to the working dir for display. */
export function displayPath(paths: Pick<ProtectedPaths, 'workingDir'>, path: string): string {
  if (!paths.workingDir) return path;
  const rel = relative(paths.workingDir, path);
  return rel && !rel.startsWith('..') ? rel : path;
}
