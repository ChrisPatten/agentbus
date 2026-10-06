import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { load as parseYaml } from 'js-yaml';
import dotenv from 'dotenv';
import { AppConfigSchema, type AppConfig } from './schema.js';
import { RuntimeResolver, collectRuntimeRequirements, validateRuntimeRequirements } from '../core/runtime-resolver.js';
import { legacyJournalingBlocks, resolveJournalingSettings } from '../journaling/config.js';
import { legacyMemoryBlocks } from '../memory/layout.js';

/**
 * Walk an unknown object tree and replace all `${VAR_NAME}` tokens in string
 * values with the corresponding `process.env` value.
 *
 * Throws a descriptive error if a referenced variable is undefined.
 */
/** Expand a leading `~` to the user's home directory. */
function expandTilde(s: string): string {
  if (s === '~') return homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return `${homedir()}${s.slice(1)}`;
  return s;
}

function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return expandTilde(obj).replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
      const val = process.env[varName];
      if (val === undefined) {
        throw new Error(`Config references undefined env var: ${varName}`);
      }
      return val;
    });
  }
  if (Array.isArray(obj)) return obj.map(substituteEnvVars);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        k,
        substituteEnvVars(v),
      ])
    );
  }
  return obj;
}

/** Retired summarizer keys (E66) present in the raw `memory` block. */
export const RETIRED_MEMORY_KEYS = ['claude_api_model', 'summary_max_tokens', 'structured_extraction'] as const;

export function retiredMemoryKeys(raw: unknown): string[] {
  const memory = (raw as { memory?: unknown } | null)?.memory;
  if (!memory || typeof memory !== 'object') return [];
  return RETIRED_MEMORY_KEYS.filter((k) => k in (memory as Record<string, unknown>));
}

/**
 * Load, validate, and return the application configuration.
 *
 * Load sequence:
 *  1. Load `.env` via dotenv (populates `process.env`)
 *  2. Read `config.yaml` from `path`
 *  3. Parse YAML → raw JS object
 *  4. Substitute `${VAR_NAME}` tokens with env values
 *  5. Validate against Zod schema
 *  6. Check feature requirements against agent runtime capabilities (E64)
 *  7. Return typed `AppConfig`
 *
 * Throws on any validation or substitution failure; process should exit non-zero.
 */
export function loadConfig(path: string, envPath?: string): AppConfig {
  // MCP stdio reserves stdout for protocol frames. dotenv's startup banner
  // would corrupt the initialize response when cc.ts loads this config.
  dotenv.config({ path: envPath ?? resolve(dirname(path), '.env'), quiet: true });

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read config file at "${path}": ${(err as Error).message}`);
  }

  const parsed = parseYaml(raw);
  const substituted = substituteEnvVars(parsed);

  const result = AppConfigSchema.safeParse(substituted);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${formatted}`);
  }

  // E64 — reject configs that ask a runtime for a capability it lacks, naming
  // the feature, agent, runtime and missing capability.
  const requirements = collectRuntimeRequirements(result.data);
  if (requirements.length > 0) {
    validateRuntimeRequirements(new RuntimeResolver(result.data), requirements);
  }

  // E66 — the cc-headless `journaling` block is a deprecated alias for
  // `agents.<id>.journaling`. Logged to stderr (stdout is MCP's in cc.ts).
  const legacy = legacyJournalingBlocks(substituted);
  if (legacy.length > 0) {
    const settings = resolveJournalingSettings(result.data);
    const shadowed = [...settings.values()].filter((s) => s.source === 'agents').length > 0;
    console.warn(
      `[config] ${legacy.join(', ')} is deprecated; move it to agents.<agent-id>.journaling (see docs/JOURNALING.md).` +
        (shadowed ? ' Agents that have agents.<id>.journaling ignore their cc-headless block.' : ''),
    );
  }

  // E67 — the cc-headless `memory` block is a deprecated alias for
  // agents.<id>.memory. Its fields still apply where the agent block is unset.
  const legacyMemory = legacyMemoryBlocks(substituted);
  if (legacyMemory.length > 0) {
    console.warn(
      `[config] ${legacyMemory.join(', ')} is deprecated; move it to agents.<agent-id>.memory ` +
        '(journal_lookback_days is lookback_days there; see docs/AGENT_MEMORY.md). ' +
        'Fields set in agents.<id>.memory take precedence.',
    );
  }

  // E66 — summarizer settings are accepted but ignored.
  const retired = retiredMemoryKeys(substituted);
  if (retired.length > 0) {
    console.warn(
      `[config] ${retired.map((k) => `memory.${k}`).join(', ')} ${retired.length === 1 ? 'is' : 'are'} deprecated and ignored: ` +
        'the Anthropic-API summarizer was retired (journaling replaces it, see docs/JOURNALING.md). Remove ' +
        `${retired.length === 1 ? 'it' : 'them'} from config.yaml.`,
    );
  }

  // Ensure the db directory exists so better-sqlite3 can create the file
  const dbDir = dirname(result.data.bus.db_path);
  mkdirSync(dbDir, { recursive: true });

  return result.data;
}
