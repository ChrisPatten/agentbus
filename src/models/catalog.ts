/**
 * Model catalog and name resolution (E54 S54.1).
 *
 * Backs the `/model` command: a static list of known Claude models, extended
 * by the optional `models.catalog` config section, and a resolver that turns
 * loose user input (`haiku`, `opus 5`, `claude haiku 4.5`, an exact id) into
 * one concrete catalog entry. The concrete `id` is what gets stored as the
 * agent's model override — never the alias.
 *
 * Pure functions, no I/O.
 */
import type { AppConfig } from '../config/schema.js';

export interface ModelEntry {
  /** Concrete model id passed to `--model`, e.g. 'claude-opus-5-5'. */
  id: string;
  /** Model family, lower-case: 'opus' | 'sonnet' | 'haiku' | 'fable'. */
  family: string;
  /** Dotted version, e.g. '5.5' — compared numerically segment by segment. */
  version: string;
  /** Display label, e.g. 'Opus 5.5'. */
  label: string;
  /** Hidden from picker/list; still resolvable by exact id or version. */
  deprecated?: boolean;
}

/** Built-in catalog. Update when new models ship; config can extend it meanwhile. */
export const BUILTIN_MODELS: ModelEntry[] = [
  { id: 'claude-fable-5-1', family: 'fable', version: '5.1', label: 'Fable 5.1' },
  { id: 'claude-opus-5-5', family: 'opus', version: '5.5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', family: 'sonnet', version: '5.5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', family: 'haiku', version: '5.5', label: 'Haiku 5.5' },
  { id: 'claude-opus-5', family: 'opus', version: '5', label: 'Opus 5', deprecated: true },
  { id: 'claude-sonnet-5', family: 'sonnet', version: '5', label: 'Sonnet 5', deprecated: true },
  { id: 'claude-sonnet-4-6', family: 'sonnet', version: '4.6', label: 'Sonnet 4.6', deprecated: true },
  { id: 'claude-haiku-4-5', family: 'haiku', version: '4.5', label: 'Haiku 4.5', deprecated: true },
];

/**
 * Build the effective catalog: the built-in entries merged with
 * `config.models.catalog`. A config entry with the same `id` as a built-in
 * replaces it in place; new ids are appended in config order.
 *
 * @param config - Validated application config
 * @returns The merged catalog (a fresh array; BUILTIN_MODELS is not mutated)
 */
export function loadCatalog(config: AppConfig): ModelEntry[] {
  const merged = BUILTIN_MODELS.map((e) => ({ ...e }));
  for (const entry of config.models?.catalog ?? []) {
    const normalized: ModelEntry = { ...entry, family: entry.family.toLowerCase() };
    const idx = merged.findIndex((e) => e.id === normalized.id);
    if (idx >= 0) merged[idx] = normalized;
    else merged.push(normalized);
  }
  return merged;
}

export type ModelQueryResult =
  | { ok: true; entry: ModelEntry; exact: boolean }
  | {
      ok: false;
      reason: 'unknown-family' | 'unknown-version' | 'empty';
      message: string;
      suggestions: ModelEntry[];
    };

/**
 * Compare two dotted versions numerically, segment by segment. Missing
 * segments count as 0, so '5' equals '5.0'.
 *
 * @returns Negative if a < b, positive if a > b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const as = a.split('.').map(Number);
  const bs = b.split('.').map(Number);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const d = (as[i] ?? 0) - (bs[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Display form of a family name: 'haiku' → 'Haiku'. */
export function familyLabel(family: string): string {
  return family.charAt(0).toUpperCase() + family.slice(1);
}

/** Entries sorted latest first. */
function byVersionDesc(entries: ModelEntry[]): ModelEntry[] {
  return [...entries].sort((x, y) => compareVersions(y.version, x.version));
}

/** Families in catalog order (first appearance). */
function familiesOf(catalog: ModelEntry[]): string[] {
  return [...new Set(catalog.map((e) => e.family))];
}

/**
 * Latest entry of a family: highest non-deprecated version, or the highest
 * deprecated one if the family has nothing else.
 */
function latestOf(catalog: ModelEntry[], family: string): ModelEntry | undefined {
  const members = catalog.filter((e) => e.family === family);
  const live = members.filter((e) => !e.deprecated);
  return byVersionDesc(live.length ? live : members)[0];
}

/** Latest entry of each family, in catalog family order. */
function latestPerFamily(catalog: ModelEntry[]): ModelEntry[] {
  return familiesOf(catalog)
    .map((f) => latestOf(catalog, f))
    .filter((e): e is ModelEntry => e !== undefined);
}

/** True when every segment of `prefix` equals the matching segment of `version`. */
function versionHasPrefix(version: string, prefix: string): boolean {
  const vs = version.split('.').map(Number);
  const ps = prefix.split('.').map(Number);
  if (ps.length > vs.length) return false;
  return ps.every((p, i) => p === vs[i]);
}

/** Family, optional version, after an optional leading `claude`. */
const QUERY_RE = /^(?:claude[\s_-]*)?([a-z]+)[\s_-]*(\d+(?:\.\d+)*)?$/;

/** Shape of a real model id, for the `claude-` escape hatch. */
const RAW_ID_RE = /^claude-[a-z0-9][a-z0-9-]*$/;

/**
 * Resolve loose user input to a catalog entry. Input is trimmed and
 * lower-cased; spaces, `-`, and `_` between family and version are
 * equivalent and a leading `claude` is optional. In order:
 *
 *   1. Exact catalog id → that entry, `exact: true`.
 *   2. Family only (`haiku`) → latest non-deprecated entry of the family.
 *   3. Family + version prefix (`opus 5`, `haiku 4.5`) → highest version
 *      whose segments start with the given ones; deprecated entries count.
 *   4. `claude-…` id-shaped input not otherwise resolved → accepted as-is
 *      with a synthetic entry (`family: 'unknown'`, `label: id`), so models
 *      released after the catalog was updated still work.
 *   5. Known family, no version match → `unknown-version`.
 *   6. Anything else → `unknown-family`.
 *
 * @param query - Raw user input, e.g. 'Haiku 4.5'
 * @param catalog - Effective catalog from loadCatalog()
 */
export function resolveModelQuery(query: string, catalog: ModelEntry[]): ModelQueryResult {
  const q = query.trim().toLowerCase();

  if (!q) {
    return {
      ok: false,
      reason: 'empty',
      message: 'Name a model, e.g. opus or haiku 4.5',
      suggestions: latestPerFamily(catalog),
    };
  }

  const exact = catalog.find((e) => e.id.toLowerCase() === q);
  if (exact) return { ok: true, entry: exact, exact: true };

  const m = QUERY_RE.exec(q);
  const family = m?.[1];
  const version = m?.[2];
  const members = family ? catalog.filter((e) => e.family === family) : [];

  if (members.length > 0) {
    if (!version) {
      return { ok: true, entry: latestOf(catalog, family!)!, exact: false };
    }
    const match = byVersionDesc(members.filter((e) => versionHasPrefix(e.version, version)))[0];
    if (match) return { ok: true, entry: match, exact: false };
  }

  if (RAW_ID_RE.test(q)) {
    return { ok: true, entry: { id: q, family: 'unknown', version: '', label: q }, exact: true };
  }

  if (members.length > 0) {
    const live = members.filter((e) => !e.deprecated);
    const suggestions = byVersionDesc(live.length ? live : members);
    return {
      ok: false,
      reason: 'unknown-version',
      message: `No ${familyLabel(family!)} ${version} — known: ${suggestions.map((e) => e.version).join(', ')}`,
      suggestions,
    };
  }

  const known = familiesOf(catalog).map(familyLabel).join(', ');
  return {
    ok: false,
    reason: 'unknown-family',
    message: `Unknown model "${query.trim()}" — known: ${known}`,
    suggestions: latestPerFamily(catalog),
  };
}
