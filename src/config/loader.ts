import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { load as parseYaml } from 'js-yaml';
import dotenv from 'dotenv';
import { AppConfigSchema, type AppConfig } from './schema.js';

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

/**
 * Load, validate, and return the application configuration.
 *
 * Load sequence:
 *  1. Load `.env` via dotenv (populates `process.env`)
 *  2. Read `config.yaml` from `path`
 *  3. Parse YAML → raw JS object
 *  4. Substitute `${VAR_NAME}` tokens with env values
 *  5. Validate against Zod schema
 *  6. Return typed `AppConfig`
 *
 * Throws on any validation or substitution failure; process should exit non-zero.
 */
export function loadConfig(path: string, envPath?: string): AppConfig {
  dotenv.config({ path: envPath ?? resolve(dirname(path), '.env') });

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

  // Ensure the db directory exists so better-sqlite3 can create the file
  const dbDir = dirname(result.data.bus.db_path);
  mkdirSync(dbDir, { recursive: true });

  return result.data;
}
