import type { AppConfig } from '../../config/schema.js';
import type { PipelineStage, ResolvedContact } from '../types.js';

type ContactEntry = AppConfig['contacts'][string];

/**
 * Stage 20 — Contact Resolve
 *
 * Looks up the sender in config.contacts and rewrites envelope.sender to the
 * canonical "contact:{id}" format. Sets ctx.contact with resolved info, or
 * null if the sender is unknown. Never aborts the pipeline.
 *
 * Lookup maps are built once at construction time for O(1) per-message cost
 * regardless of contact count.
 */
export function createContactResolve(config: AppConfig): PipelineStage {
  const byId = new Map<string, ContactEntry>();
  const byTelegramUserId = new Map<string, ContactEntry>();
  const byTelegramUsername = new Map<string, ContactEntry>();
  const byBlueBubblesHandle = new Map<string, ContactEntry>();

  for (const contact of Object.values(config.contacts)) {
    byId.set(contact.id, contact);
    if (contact.platforms.telegram) {
      byTelegramUserId.set(String(contact.platforms.telegram.userId), contact);
      if (contact.platforms.telegram.username) {
        byTelegramUsername.set(contact.platforms.telegram.username, contact);
      }
    }
    if (contact.platforms.bluebubbles) {
      byBlueBubblesHandle.set(contact.platforms.bluebubbles.handle, contact);
    }
  }

  return async (ctx) => {
    const e = ctx.envelope;

    // Already canonical agent: prefix — pass through
    if (e.sender.startsWith('agent:')) {
      return ctx;
    }

    // Already canonical contact: prefix — look up by id
    if (e.sender.startsWith('contact:')) {
      const contactId = e.sender.slice('contact:'.length);
      const contact = byId.get(contactId);
      if (contact) {
        ctx.contact = toResolved(contact);
      }
      return ctx;
    }

    // Platform-specific lookup via pre-built maps
    let found: ContactEntry | undefined;
    if (e.channel === 'telegram') {
      found = byTelegramUserId.get(e.sender) ?? byTelegramUsername.get(e.sender);
    } else if (e.channel === 'bluebubbles') {
      found = byBlueBubblesHandle.get(e.sender);
    }

    if (found) {
      e.sender = `contact:${found.id}`;
      ctx.contact = toResolved(found);
      return ctx;
    }

    // Unknown sender — reformat to platform:channel:id for traceability
    if (!e.sender.includes(':')) {
      e.sender = `platform:${e.channel}:${e.sender}`;
    }
    ctx.contact = null;
    return ctx;
  };
}

function toResolved(contact: ContactEntry): ResolvedContact {
  return {
    id: contact.id,
    displayName: contact.displayName,
    platforms: contact.platforms as Record<string, unknown>,
  };
}
