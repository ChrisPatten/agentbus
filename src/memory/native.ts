/**
 * Native memory loading (E67 S67.3). See docs/AGENT_MEMORY.md#loading.
 *
 * On runtimes with the `nativeMemory` capability the bus no longer injects
 * memory. Instead every `claude` it starts gets
 * `--settings '{"autoMemoryDirectory":"<memory dir>"}'`, so Claude Code's
 * auto memory loads the agent's own `MEMORY.md` (first 200 lines / 25KB) and
 * reads topic files on demand, without per-agent setup. `--settings` is a
 * CLI-scope settings layer: it works in `-p` mode, with `--resume` and with
 * `--system-prompt-file` (verified, see the E67 implementation notes),
 * unlike a checked-in project `.claude/settings.json`, where Claude Code
 * ignores `autoMemoryDirectory`.
 */
import type { RuntimeCapabilities } from '../core/runtime-capabilities.js';
import type { MemoryLayout } from './layout.js';

/** Environment variable that turns Claude Code auto memory off. */
export const DISABLE_AUTO_MEMORY_ENV = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';

/** True when the agent loads memory natively: its layout allows it and its runtime supports it. */
export function usesNativeMemory(layout: Pick<MemoryLayout, 'native'>, capabilities: Pick<RuntimeCapabilities, 'nativeMemory'>): boolean {
  return layout.native && capabilities.nativeMemory;
}

/** The `--settings` JSON pointing auto memory at `memoryDir`. */
export function autoMemorySettings(memoryDir: string): string {
  return JSON.stringify({ autoMemoryDirectory: memoryDir });
}

/** `['--settings', <json>]` for a native agent with a memory dir, else `[]`. */
export function autoMemoryArgs(layout: Pick<MemoryLayout, 'native' | 'memoryDir'>, capabilities: Pick<RuntimeCapabilities, 'nativeMemory'>): string[] {
  if (!usesNativeMemory(layout, capabilities) || !layout.memoryDir) return [];
  return ['--settings', autoMemorySettings(layout.memoryDir)];
}

/** True when `args` already pass `--settings` (an operator's own launch args win). */
export function hasSettingsArg(args: readonly string[]): boolean {
  return args.some((a) => a === '--settings' || a.startsWith('--settings='));
}
