/**
 * Journaler registry (E66 S66.5). One instance per bus; the engine looks
 * journalers up by id when it walks an agent's chain. Registering an id
 * again replaces the earlier journaler, so a real implementation can take
 * over from a provisional one.
 */
import type { Journaler, JournalerId } from './types.js';

export class JournalerRegistry {
  private readonly journalers = new Map<JournalerId, Journaler>();

  register(journaler: Journaler): void {
    this.journalers.set(journaler.id, journaler);
  }

  unregister(id: JournalerId): void {
    this.journalers.delete(id);
  }

  get(id: JournalerId): Journaler | undefined {
    return this.journalers.get(id);
  }

  has(id: JournalerId): boolean {
    return this.journalers.has(id);
  }

  ids(): JournalerId[] {
    return [...this.journalers.keys()];
  }
}
