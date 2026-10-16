/**
 * Memory setup checks (E67 S67.5): what `/journal` and the startup log warn
 * about. See docs/AGENT_MEMORY.md#setup-checks.
 *
 *   - How recent.md reaches the agent (E73): an `@memory/recent.md` import in
 *     its CLAUDE.md, or the freshness hook registered for SessionStart. With
 *     both, the bus is in import mode and the hook only sends updates (the
 *     file is not loaded twice); with bus injection either would load it twice.
 *   - The memory dir setting in effect: who supplies autoMemoryDirectory, and
 *     settings files that set it where it is ignored or overridden.
 *   - The memory dir exists.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentRuntime } from '../core/runtime-resolver.js';
import type { MemoryLayout } from './layout.js';
import { hasSettingsArg, usesNativeMemory } from './native.js';

/** Claude Code follows `@` imports this many hops deep. */
export const MAX_IMPORT_DEPTH = 4;

/** The freshness hook script that can deliver recent.md (E73). */
export const RECENT_HOOK_SCRIPT = 'agentbus_recent_memory_hook.sh';

/** How recent.md reaches the agent: `both` is import mode (the hook only sends updates), `none` means it never arrives. */
export type RecentDelivery = 'import' | 'hook' | 'both' | 'none';

export interface MemorySetupStatus {
  agentId: string;
  loading: 'native' | 'injected' | 'none';
  memoryDir: string | null;
  memoryDirExists: boolean;
  /** Who supplies autoMemoryDirectory for native loading. */
  autoMemorySource: 'bus' | 'settings-file' | 'operator' | 'unknown' | null;
  /** Does the CLAUDE.md hierarchy (with imports) import recent.md? null = can't tell (no working dir). */
  importsRecent: boolean | null;
  /** Is the freshness hook registered for SessionStart in .claude/settings(.local).json? null = can't tell (no working dir). */
  hooksRecent: boolean | null;
  /** How recent.md is delivered (import, hook, both, none). null = can't tell (no working dir). */
  recentDelivery: RecentDelivery | null;
  /** Which CLAUDE.md files were read. */
  claudeMdFiles: string[];
  warnings: string[];
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function exists(path: string | null, kind: 'dir' | 'file'): boolean {
  if (!path) return false;
  try {
    const st = statSync(path);
    return kind === 'dir' ? st.isDirectory() : st.isFile();
  } catch {
    return false;
  }
}

/** `@path` imports in a memory file, outside fenced code blocks and inline code spans. */
export function parseImports(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const plain = line.replace(/`[^`]*`/g, ' ');
    for (const m of plain.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[^\s@`'"<>()]+)/g)) {
      const p = m[1]!.replace(/[.,;:!?)\]]+$/, '');
      if (p.length > 0 && !p.includes('://')) out.push(p);
    }
  }
  return out;
}

function resolveImport(p: string, fromFile: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(dirname(fromFile), p);
}

/**
 * The roots that exist plus every path they import through `@` (depth-limited
 * like Claude Code). Import targets are included whether or not they exist
 * yet (recent.md may not have been generated).
 */
export function importClosure(roots: string[], maxDepth = MAX_IMPORT_DEPTH): Set<string> {
  const out = new Set<string>();
  const read = new Set<string>();
  const walk = (file: string, depth: number) => {
    if (read.has(file)) return;
    read.add(file);
    const text = readText(file);
    if (text === null) return;
    out.add(file);
    if (depth >= maxDepth) return;
    for (const p of parseImports(text)) {
      const target = resolveImport(p, file);
      out.add(target);
      if (/\.(md|markdown|txt)$/i.test(target)) walk(target, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}

function settingsAutoMemoryDir(path: string): string | null | undefined {
  const text = readText(path);
  if (text === null) return undefined;
  try {
    const v = (JSON.parse(text) as { autoMemoryDirectory?: unknown }).autoMemoryDirectory;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Does one hook command run the recent-memory hook script? Matches on the basename, through env prefixes, quotes, relative paths and symlinks. */
function commandRunsRecentHook(command: string, workingDir: string): boolean {
  for (const raw of command.split(/[\s;&|()]+/)) {
    const token = raw.replace(/^["'`]+|["'`]+$/g, '');
    if (!token || (token.includes('=') && !token.includes('/'))) continue; // VAR=value prefix
    const path = token.replace(/^[^/]*=/, ''); // VAR=/path/to/script
    if (basename(path) === RECENT_HOOK_SCRIPT) return true;
    if (!path.includes('/')) continue;
    try {
      const abs = path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(workingDir, path);
      if (basename(realpathSync(abs)) === RECENT_HOOK_SCRIPT) return true; // a symlink to the script
    } catch { /* not a file */ }
  }
  return false;
}

/**
 * Does a Claude Code settings file register the recent-memory hook for
 * SessionStart? Missing file, malformed JSON or an unexpected shape = no.
 */
export function settingsRegisterRecentHook(path: string, workingDir: string): boolean {
  const text = readText(path);
  if (text === null) return false;
  try {
    const settings = JSON.parse(text) as { disableAllHooks?: unknown; hooks?: { SessionStart?: unknown } };
    if (settings.disableAllHooks === true) return false;
    const groups = settings.hooks?.SessionStart;
    if (!Array.isArray(groups)) return false;
    return groups.some((g: { hooks?: unknown }) =>
      Array.isArray(g?.hooks) && g.hooks.some((h: { command?: unknown }) => typeof h?.command === 'string' && commandRunsRecentHook(h.command, workingDir)));
  } catch {
    return false;
  }
}

/** The CLAUDE.md files Claude Code loads from a working dir (project, .claude/, local). */
export function claudeMdRoots(workingDir: string): string[] {
  return [join(workingDir, 'CLAUDE.md'), join(workingDir, '.claude', 'CLAUDE.md'), join(workingDir, 'CLAUDE.local.md')];
}

/** Does the working dir's CLAUDE.md hierarchy (following `@` imports) import `recentPath`? */
export function claudeMdImportsRecent(workingDir: string, recentPath: string): boolean {
  return importClosure(claudeMdRoots(workingDir)).has(recentPath);
}

/** Check one agent's memory setup against its runtime. Reads files; never throws. */
export function checkMemorySetup(layout: MemoryLayout, runtime: AgentRuntime | undefined): MemorySetupStatus {
  const warnings: string[] = [];
  const native = runtime ? usesNativeMemory(layout, runtime.capabilities) : false;
  const injected = !native && runtime?.kind === 'cc-headless';
  const loading: MemorySetupStatus['loading'] = native ? 'native' : injected ? 'injected' : 'none';
  const memoryDirExists = exists(layout.memoryDir, 'dir');
  const rel = `${layout.dir.replace(/\/+$/, '')}/recent.md`;

  if (!layout.memoryDir) {
    warnings.push(`memory dir unresolved: "${layout.dir}" is relative and ${runtime?.kind ?? 'the agent'} has no working dir; set agents.<id>.memory.dir to an absolute path`);
  } else if (!memoryDirExists) {
    warnings.push(`memory dir ${layout.memoryDir} does not exist`);
  }

  // autoMemoryDirectory in effect.
  let autoMemorySource: MemorySetupStatus['autoMemorySource'] = null;
  const wd = layout.workingDir;
  const projectSetting = wd ? settingsAutoMemoryDir(join(wd, '.claude', 'settings.json')) : undefined;
  const localSetting = wd ? settingsAutoMemoryDir(join(wd, '.claude', 'settings.local.json')) : undefined;
  if (native) {
    if (runtime?.kind === 'cc-headless') autoMemorySource = 'bus';
    else if (runtime?.kind === 'cc-pool') autoMemorySource = hasSettingsArg(runtime.pool.launch_args) ? 'operator' : 'bus';
    else autoMemorySource = localSetting ? 'settings-file' : 'unknown';
    if (autoMemorySource === 'operator') {
      warnings.push('launch_args pass their own --settings, so the bus does not set autoMemoryDirectory; that settings file must set it to ' + layout.memoryDir);
    }
    if (autoMemorySource === 'unknown') {
      warnings.push(`autoMemoryDirectory is not set by the bus for ${runtime?.kind ?? 'this runtime'}; set it to ${layout.memoryDir ?? 'the memory dir'} in the agent's .claude/settings.local.json or user settings`);
    }
    if (typeof projectSetting === 'string') {
      warnings.push('.claude/settings.json sets autoMemoryDirectory, which Claude Code ignores in checked-in project settings' +
        (autoMemorySource === 'bus' ? ' (the bus supplies it anyway; remove it)' : '; move it to .claude/settings.local.json'));
    }
    if (typeof localSetting === 'string' && layout.memoryDir && resolve(wd ?? '', localSetting.replace(/^~\//, `${homedir()}/`)) !== layout.memoryDir && autoMemorySource === 'bus') {
      warnings.push(`.claude/settings.local.json sets autoMemoryDirectory to ${localSetting}; the bus's --settings (${layout.memoryDir}) overrides it`);
    }
  }

  // How recent.md is delivered: CLAUDE.md import and/or the SessionStart hook.
  let importsRecent: boolean | null = null;
  let hooksRecent: boolean | null = null;
  let recentDelivery: RecentDelivery | null = null;
  const claudeMdFiles: string[] = [];
  if (wd) {
    const roots = claudeMdRoots(wd);
    claudeMdFiles.push(...roots.filter((r) => exists(r, 'file')));
    importsRecent = layout.recentPath ? claudeMdImportsRecent(wd, layout.recentPath) : false;
    hooksRecent = settingsRegisterRecentHook(join(wd, '.claude', 'settings.json'), wd) ||
      settingsRegisterRecentHook(join(wd, '.claude', 'settings.local.json'), wd);
    recentDelivery = importsRecent && hooksRecent ? 'both' : importsRecent ? 'import' : hooksRecent ? 'hook' : 'none';
    if (native && recentDelivery === 'none') {
      warnings.push((claudeMdFiles.length === 0
        ? `no CLAUDE.md in ${wd} imports @${rel}`
        : `CLAUDE.md does not import @${rel}`) +
        ` and no SessionStart hook runs ${RECENT_HOOK_SCRIPT}, so the agent never sees its recent journals; ` +
        `register the hook in .claude/settings.json (or add the import)`);
    }
    if (native && recentDelivery === 'both') {
      warnings.push(`CLAUDE.md imports @${rel}, so the freshness hook ${RECENT_HOOK_SCRIPT} only sends updates; Claude Code re-reads the whole file whenever it changes. ` +
        'Remove the import to let the hook deliver it (full on session start, new entries after)');
    }
    if (injected && importsRecent) {
      warnings.push(`CLAUDE.md imports @${rel} and the bus injects it too (memory.native: false); remove one`);
    }
    if (injected && hooksRecent) {
      warnings.push(`the SessionStart hook ${RECENT_HOOK_SCRIPT} delivers recent.md and the bus injects it too (memory.native: false); remove one`);
    }
  } else if (native) {
    warnings.push(`can't check how recent.md is delivered for ${runtime?.kind ?? 'this runtime'} (no working dir); make sure CLAUDE.md imports ${layout.recentPath ?? 'recent.md'} or the agent's project registers the SessionStart hook ${RECENT_HOOK_SCRIPT} (with both, the hook only sends updates)`);
  }

  return {
    agentId: layout.agentId, loading, memoryDir: layout.memoryDir, memoryDirExists, autoMemorySource, importsRecent, hooksRecent, recentDelivery, claudeMdFiles, warnings,
  };
}
