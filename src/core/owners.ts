/**
 * Owner contacts (E65 S65.1).
 *
 * Each agent can name one or more owners under `agents.<id>.owners`: the
 * people who receive bus advisories about it, each on one channel. This
 * module is the lookup side. It changes no behavior on its own.
 *
 * Agent ids are accepted bare or prefixed. A cc-pool pane id
 * (`<pool>-pool-<n>`) maps to its pool's logical id, so a lookup made with
 * the id a message was actually routed to finds the pool's owners.
 *
 * Owners are used for advisories (and E68 proposals) only. They are not a
 * trust tier for journaling or memory.
 */
import { getCcPoolInstances, type AppConfig } from '../config/schema.js';
import { computeConversationId } from '../pipeline/conversation-id.js';

export interface OwnerContact {
  /** Exact channel the owner's conversation arrives on, e.g. "telegram:peggy". */
  channel: string;
  /** Bare contact key, e.g. "chris". */
  contactId: string;
}

export interface OwnerConversation extends OwnerContact {
  /** The owner's default conversation topic. Always "general" (the app's Main). */
  topic: string;
  /** `computeConversationId(contactId, channel, topic)`, as route-resolve computes it. */
  conversationId: string;
}

/** Topic of an owner's default conversation. */
export const OWNER_DEFAULT_TOPIC = 'general';

const AGENT_PREFIX = 'agent:';
const toPrefixed = (id: string) => (id.startsWith(AGENT_PREFIX) ? id : `${AGENT_PREFIX}${id}`);
const toBare = (id: string) => (id.startsWith(AGENT_PREFIX) ? id.slice(AGENT_PREFIX.length) : id);
const toBareContact = (id: string) => (id.startsWith('contact:') ? id.slice('contact:'.length) : id);

/**
 * Owner lookup over one config. Build once and reuse; the maps are computed
 * in the constructor.
 */
export class OwnerDirectory {
  /** Prefixed agent id → owners. */
  private readonly byAgent = new Map<string, OwnerContact[]>();
  /** Prefixed pool ids, for pane-id → pool-id mapping. */
  private readonly poolIds = new Set<string>();

  constructor(config: Pick<AppConfig, 'agents' | 'adapters'>) {
    for (const [key, agent] of Object.entries(config.agents ?? {})) {
      const owners = (agent.owners ?? []).map((o) => ({ channel: o.channel, contactId: o.contact_id }));
      if (owners.length === 0) continue;
      const id = toPrefixed(key);
      this.byAgent.set(id, [...(this.byAgent.get(id) ?? []), ...owners]);
    }
    // Partial configs built by cast in tests may lack adapters.
    if (config.adapters) {
      for (const pool of getCcPoolInstances(config as AppConfig)) this.poolIds.add(toPrefixed(pool.agent_id));
    }
  }

  /**
   * The id owners are configured under: prefixed, with a cc-pool pane id
   * (`agent:peggy-pool-2`) mapped to its pool (`agent:peggy`).
   */
  logicalAgentId(agentId: string): string {
    const id = toPrefixed(agentId);
    if (this.byAgent.has(id) || this.poolIds.has(id)) return id;
    const match = /^(.+)-pool-\d+$/.exec(toBare(id));
    if (match && this.poolIds.has(toPrefixed(match[1]!))) return toPrefixed(match[1]!);
    return id;
  }

  /** Configured owners of an agent, in config order. Empty when none. */
  owners(agentId: string): OwnerContact[] {
    return [...(this.byAgent.get(this.logicalAgentId(agentId)) ?? [])];
  }

  /** True when `contactId` (bare or `contact:`-prefixed) owns `agentId` on exactly `channel`. */
  isOwner(agentId: string, contactId: string, channel: string): boolean {
    const contact = toBareContact(contactId);
    return this.owners(agentId).some((o) => o.contactId === contact && o.channel === channel);
  }

  /** Each owner's default conversation with the agent (topic "general"). */
  ownerConversations(agentId: string): OwnerConversation[] {
    return this.owners(agentId).map((o) => ({
      ...o,
      topic: OWNER_DEFAULT_TOPIC,
      conversationId: computeConversationId(o.contactId, o.channel, OWNER_DEFAULT_TOPIC),
    }));
  }

  /** Every agent (prefixed) that has at least one owner, sorted. */
  agentsWithOwners(): string[] {
    return [...this.byAgent.keys()].sort();
  }
}

/** One-off helpers for callers that don't keep a directory around. */
export function isOwner(config: Pick<AppConfig, 'agents' | 'adapters'>, agentId: string, contactId: string, channel: string): boolean {
  return new OwnerDirectory(config).isOwner(agentId, contactId, channel);
}

export function ownerConversations(config: Pick<AppConfig, 'agents' | 'adapters'>, agentId: string): OwnerConversation[] {
  return new OwnerDirectory(config).ownerConversations(agentId);
}
