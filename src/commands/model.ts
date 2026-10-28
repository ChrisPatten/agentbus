/**
 * `/model` — show or change the model of the agent this chat routes to (E54 S54.3).
 *
 * Writes the agent-scoped `model_overrides` row (E53). cc-headless uses it on
 * its next spawn. For cc-pool, when this chat holds a live pane and it is
 * between turns, the pane is relaunched on the new model right away
 * (`PoolManager.applyModelNow`) and Claude Code's model-confirmation prompt is
 * answered with `1`; otherwise the pane switches at its next message. Factored into its own module, like `src/commands/pool.ts` and
 * `src/commands/cost.ts`, so it can carry its own deps and be unit-tested.
 */
import type Database from 'better-sqlite3';
import type { CommandChoice, CommandDefinition, CommandResponse, SlashCommandContext } from './registry.js';
import type { AppConfig } from '../config/schema.js';
import { getCcHeadlessInstances, getCcPoolInstances } from '../config/schema.js';
import { loadCatalog, resolveModelQuery, familyLabel, compareVersions, type ModelEntry } from '../models/catalog.js';
import {
  resolveModel,
  setModelOverride,
  deleteModelOverride,
  type ModelSource,
} from '../adapters/model-override-loader.js';
import { toBareAgentId, toPrefixedAgentId } from '../pool/types.js';
import { channelMatches } from '../pipeline/types.js';
import type { PoolManager } from '../pool/pool-manager.js';
import { commandConversationId } from './handlers.js';
import { MAX_CHOICES, MAX_CHOICE_LABEL_LENGTH } from '../choices/types.js';

export interface ModelCommandDeps {
  /** Writable handle — `ctx.db` is read-only. */
  db: Database.Database;
  /** cc-pool managers, for applying a change to the live pane. Omit and every change is override-only. */
  poolManagers?: Map<string, PoolManager>;
}

/** The agent `/model` acts on. */
export interface ModelTarget {
  /** Prefixed agent id the override is keyed on, e.g. "agent:peggy". */
  agentId: string;
  /** Display name, e.g. "Peggy". */
  name: string;
  /** The instance's configured `model`, if any. */
  configModel: string | undefined;
  /** Bare pool agent id when the agent is a cc-pool instance (absent for cc-headless). */
  poolId?: string;
}

const NOT_ROUTED = "This chat isn't routed to an agent whose model I can change.";

const SOURCE_WORDING: Record<ModelSource, string> = {
  schedule: 'from a schedule',
  'agent-override': 'set with /model',
  'global-override': 'global override',
  config: 'from config',
  'cli-default': 'CLI default — no model configured',
};

/**
 * True when a cc-pool route's recipientId belongs to the pool with bare
 * agent id `poolId`. pool-route-resolve (Stage 72) has already rewritten the
 * route by dispatch time, so it may be the pool id itself ("peggy"), a pane
 * ("peggy-pool-3"), or the parked bucket ("peggy__parked").
 */
function belongsToPool(recipientId: string, poolId: string): boolean {
  const bare = toBareAgentId(recipientId);
  if (bare === poolId || bare === `${poolId}__parked`) return true;
  return bare.startsWith(`${poolId}-pool-`) && /^\d+$/.test(bare.slice(`${poolId}-pool-`.length));
}

function displayName(agentId: string): string {
  return familyLabel(toBareAgentId(agentId));
}

/**
 * Find the agent this message routes to: the first route to `cc-pool` or
 * `cc-headless` whose instance is configured. Returns null otherwise.
 */
export function resolveTarget(
  routes: SlashCommandContext['routes'],
  config: AppConfig,
): ModelTarget | null {
  for (const route of routes ?? []) {
    if (route.adapterId === 'cc-pool') {
      const pool = safeInstances(() => getCcPoolInstances(config)).find((p) =>
        belongsToPool(route.recipientId, p.agent_id),
      );
      if (pool) {
        const agentId = toPrefixedAgentId(pool.agent_id);
        return { agentId, name: displayName(agentId), configModel: pool.model, poolId: pool.agent_id };
      }
    } else if (route.adapterId === 'cc-headless') {
      const agentId = toPrefixedAgentId(route.recipientId);
      const inst = safeInstances(() => getCcHeadlessInstances(config)).find(
        (h) => toPrefixedAgentId(h.agent_id) === agentId,
      );
      if (inst) return { agentId, name: displayName(agentId), configModel: inst.model };
    }
  }
  return null;
}

function safeInstances<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

/**
 * Count active schedules with their own `model` whose route (per
 * `config.pipeline.routes`, first matching rule) targets `target`.
 * `scheduled_items` has no agent column, so the agent is derived the same
 * way Stage 70 routes the fired envelope: by sender, channel, and topic.
 */
export function countScheduleModels(db: Database.Database, config: AppConfig, target: ModelTarget): number {
  const rules = config.pipeline?.routes ?? [];
  if (rules.length === 0) return 0;
  const bare = toBareAgentId(target.agentId);
  let rows: Array<{ channel: string; sender: string; topic: string }>;
  try {
    rows = db
      .prepare(
        `SELECT channel, sender, topic FROM scheduled_items
         WHERE status = 'active' AND model IS NOT NULL AND model != ''`,
      )
      .all() as Array<{ channel: string; sender: string; topic: string }>;
  } catch {
    return 0;
  }
  let count = 0;
  for (const row of rows) {
    const rule = rules.find(
      (r) =>
        (!r.match.sender || r.match.sender === row.sender) &&
        (!r.match.channel || channelMatches(r.match.channel, row.channel)) &&
        (!r.match.topic || r.match.topic === row.topic),
    );
    if (!rule) continue;
    const targets = [rule.target, ...(rule.also_notify ?? [])];
    const hit = targets.some(
      (t) =>
        (t.adapterId === 'cc-pool' && belongsToPool(t.recipientId, bare)) ||
        (t.adapterId === 'cc-headless' && toPrefixedAgentId(t.recipientId) === target.agentId),
    );
    if (hit) count++;
  }
  return count;
}

/** "Opus 5.5 (claude-opus-5-5)" for a catalog id; the raw value otherwise (e.g. an alias like "sonnet"). */
function describeModel(model: string, catalog: ModelEntry[]): string {
  const entry = catalog.find((e) => e.id === model);
  return entry ? `${entry.label} (${entry.id})` : model;
}

/** Non-deprecated entries grouped by family (catalog family order), latest first within family. */
function pickerEntries(catalog: ModelEntry[]): ModelEntry[] {
  const families = [...new Set(catalog.map((e) => e.family))];
  return families.flatMap((f) =>
    catalog
      .filter((e) => e.family === f && !e.deprecated)
      .sort((a, b) => compareVersions(b.version, a.version)),
  );
}

/** Truncate to E74's label limit. */
function clipLabel(label: string): string {
  return label.length > MAX_CHOICE_LABEL_LENGTH ? `${label.slice(0, MAX_CHOICE_LABEL_LENGTH - 1)}…` : label;
}

/**
 * Picker choices, capped to what E74 allows (`MAX_CHOICES` labels of
 * `MAX_CHOICE_LABEL_LENGTH` characters). `reserve` slots are held back for
 * entries the caller appends afterwards (e.g. "Reset"); picker entries are
 * already latest-first within a family, so the cap drops the oldest.
 */
function toChoices(entries: ModelEntry[], current: string | undefined, reserve = 0): CommandChoice[] {
  return entries.slice(0, MAX_CHOICES - reserve).map((e) => ({
    label: clipLabel(e.id === current ? `${e.label} (current)` : e.label),
    args: e.id,
  }));
}

export function createModelCommand(deps: ModelCommandDeps): CommandDefinition {
  return {
    name: 'model',
    description: "Show or change this chat's agent model",
    usage: '/model [opus | haiku 4.5 | <model-id> | reset | list]',
    scope: 'bus',
    handler: async (args, ctx): Promise<CommandResponse> => {
      const target = resolveTarget(ctx.routes, ctx.config);
      if (!target) return { body: NOT_ROUTED };

      const catalog = loadCatalog(ctx.config);
      const current = () => resolveModel({ db: deps.db, agentId: target.agentId, configModel: target.configModel });
      const status = (verb: string) => {
        const { model, source } = current();
        return model
          ? `${target.name} ${verb} ${describeModel(model, catalog)} — ${SOURCE_WORDING[source]}.`
          : `${target.name} ${verb} the CLI default — no model configured.`;
      };
      const withScheduleNote = (body: string) => {
        const n = countScheduleModels(deps.db, ctx.config, target);
        if (n === 0) return body;
        return `${body}\nNote: ${n} scheduled job${n === 1 ? ' sets its' : 's set their'} own model and ${n === 1 ? "isn't" : "aren't"} affected.`;
      };

      /** Push the new resolved model onto this chat's live cc-pool pane, if there is one; returns the sentence to show. */
      const applyToPool = async (): Promise<string> => {
        const later = 'Takes effect on the next message.';
        if (!target.poolId) return later;
        const manager = [...(deps.poolManagers?.values() ?? [])].find((m) => m.poolId === target.poolId);
        if (!manager) return later;
        const contactId = ctx.sender.startsWith('contact:') ? ctx.sender.slice('contact:'.length) : ctx.sender;
        const conversationId = commandConversationId(ctx, deps.db, contactId);
        const outcome = await manager.applyModelNow(conversationId, {
          contact_id: contactId,
          channel: ctx.channel,
          topic: ctx.envelope.topic,
        });
        switch (outcome.status) {
          case 'switched':
            return `Relaunched ${outcome.paneId} on the new model.`;
          case 'deferred':
            return 'A turn is in progress, so the pane switches after it, on the next message.';
          case 'failed':
            return `The change is saved, but switching the live pane failed (${outcome.reason}). Your next message starts a fresh pane on the new model.`;
          default:
            return later;
        }
      };

      const query = args.join(' ').trim();
      const keyword = query.toLowerCase();

      if (!query) {
        const { model, source } = current();
        const showReset = source === 'agent-override';
        const choices = toChoices(pickerEntries(catalog), model, showReset ? 1 : 0);
        if (showReset) {
          const fallback = target.configModel ?? 'CLI default';
          choices.push({ label: clipLabel(`Reset to config (${fallback})`), args: 'reset' });
        }
        return { body: withScheduleNote(status('is on')), choices };
      }

      if (keyword === 'list') {
        const { model } = current();
        const families = [...new Set(catalog.map((e) => e.family))];
        const lines = ['Known models:'];
        for (const f of families) {
          lines.push(familyLabel(f));
          const members = catalog
            .filter((e) => e.family === f)
            .sort((a, b) => compareVersions(b.version, a.version));
          for (const e of members) {
            const tags = [e.deprecated ? 'deprecated' : null, e.id === model ? 'current' : null].filter(Boolean);
            lines.push(`  ${e.label} — ${e.id}${tags.length ? ` (${tags.join(', ')})` : ''}`);
          }
        }
        if (model && !catalog.some((e) => e.id === model)) {
          lines.push(`${target.name} is on ${model}, which isn't in the catalog.`);
        }
        return { body: lines.join('\n') };
      }

      if (keyword === 'reset' || keyword === 'default') {
        const removed = deleteModelOverride(deps.db, target.agentId);
        if (removed === 0) {
          return { body: withScheduleNote(`No /model override to remove. ${status('is on')}`) };
        }
        const applied = await applyToPool();
        return { body: withScheduleNote(`Override removed. ${status('is now on')} ${applied}`) };
      }

      const result = resolveModelQuery(query, catalog);
      if (!result.ok) {
        return { body: result.message, choices: toChoices(result.suggestions, current().model) };
      }

      const { entry } = result;
      const before = current();
      if (before.source === 'agent-override' && before.model === entry.id) {
        return { body: `${target.name} is already on ${describeModel(entry.id, catalog)}.` };
      }

      setModelOverride(deps.db, entry.id, target.agentId);
      const shown = entry.family === 'unknown' ? entry.id : `${entry.label} (${entry.id})`;
      const lines = [`${target.name} → ${shown}. ${await applyToPool()}`];
      if (entry.family === 'unknown') {
        lines.push(`Warning: ${entry.id} isn't in the model catalog — check the id. /model list shows known models.`);
      }
      return { body: withScheduleNote(lines.join('\n')) };
    },
  };
}
