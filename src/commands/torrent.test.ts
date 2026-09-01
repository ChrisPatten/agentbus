import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { CommandRegistry } from './registry.js';
import type { SlashCommandContext } from './registry.js';
import { createTorrentCommand } from './torrent.js';
import { AdapterRegistry, type AdapterInstance } from '../core/registry.js';
import { createSafeDatabase } from '../db/safe-database.js';
import type { MessageEnvelope } from '../types/envelope.js';
import type { AppConfig } from '../config/schema.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Seeds a conversation_registry row + active session, matching what the
 * inbound pipeline would have created for prior traffic from this contact. */
function seedConversation(db: Database.Database, { contactId, channel }: { contactId: string; channel: string }) {
  const now = new Date().toISOString();
  const conversationId = randomUUID();
  db.prepare(
    `INSERT INTO conversation_registry (id, contact_id, channel, topic, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(conversationId, contactId, channel, 'general', now, now);

  const sessionId = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(sessionId, conversationId, channel, contactId, now, now);
}

function getOutboundRows(db: Database.Database) {
  return db.prepare(`SELECT * FROM transcripts WHERE direction = 'outbound'`).all() as Array<{
    contact_id: string;
    channel: string;
    body: string;
    metadata: string;
  }>;
}

function makeStubAdapter(id: string, channel: string): AdapterInstance {
  return {
    id,
    name: id,
    capabilities: { send: true, channels: [channel] },
    start: async () => {},
    stop: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    send: vi.fn().mockResolvedValue({ success: true }),
  };
}

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'invocation-id',
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'contact:chris',
    recipient: 'agent:torrent',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: '/torrent' },
    metadata: {},
    ...overrides,
  };
}

const stubConfig = {} as unknown as AppConfig;

function makeCtx(db: Database.Database, overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    channel: 'telegram',
    sender: 'contact:chris',
    adapterId: 'telegram',
    argsRaw: '',
    envelope: makeEnvelope(),
    db: createSafeDatabase(db),
    config: stubConfig,
    ...overrides,
  };
}

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

/** Flush the fire-and-forget async IIFE inside the child.on('exit', ...) handler. */
async function flush() {
  await new Promise((r) => setImmediate(r));
}

describe('/torrent command (E36)', () => {
  it('no-arg: registers a follow-up and returns the prompt instead of a usage error', async () => {
    const db = makeDb();
    const commandRegistry = new CommandRegistry();
    const registry = new AdapterRegistry();
    const spawnFn = vi.fn();
    const cmd = createTorrentCommand({ commandRegistry, db, registry, spawnFn: spawnFn as never });

    const response = await cmd.handler([], makeCtx(db));

    expect(response.body).toBe("What's the magnet link? 🧲");
    expect(spawnFn).not.toHaveBeenCalled();

    const followUp = commandRegistry.consumeFollowUp('telegram', 'contact:chris');
    expect(followUp).not.toBeNull();
    expect(followUp!.command).toBe('torrent');
    expect(followUp!.validate('magnet:?xt=abc')).toBe(true);
    expect(followUp!.validate('not a magnet')).toBe(false);
  });

  it('a non-magnet argument is treated the same as no argument: prompt + capture, not a usage error', async () => {
    // The original handler used a single `!magnet || !magnet.startsWith('magnet:')`
    // condition for both "no arg" and "bad arg" — S36.3 replaces that whole
    // branch's response, so an invalid argument also gets the prompt now.
    const db = makeDb();
    const commandRegistry = new CommandRegistry();
    const registry = new AdapterRegistry();
    const spawnFn = vi.fn();
    const cmd = createTorrentCommand({ commandRegistry, db, registry, spawnFn: spawnFn as never });

    const response = await cmd.handler(['not-a-magnet-link'], makeCtx(db));

    expect(response.body).toBe("What's the magnet link? 🧲");
    expect(spawnFn).not.toHaveBeenCalled();
    expect(commandRegistry.consumeFollowUp('telegram', 'contact:chris')).not.toBeNull();
  });

  it('direct-argument form: spawns the download script and returns the started message', async () => {
    const db = makeDb();
    const commandRegistry = new CommandRegistry();
    const registry = new AdapterRegistry();
    const fakeChild = new FakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    const cmd = createTorrentCommand({
      commandRegistry,
      db,
      registry,
      spawnFn: spawnFn as never,
      scriptPath: '/fake/script.sh',
    });

    const response = await cmd.handler(['magnet:?xt=urn:btih:abc123'], makeCtx(db));

    expect(response.body).toContain('Download started');
    expect(spawnFn).toHaveBeenCalledWith('/bin/bash', ['/fake/script.sh', 'magnet:?xt=urn:btih:abc123'], {
      detached: true,
      stdio: 'ignore',
    });
    expect(fakeChild.unref).toHaveBeenCalledTimes(1);
  });

  it('sends a success notification and logs a transcript when the download exits 0', async () => {
    const db = makeDb();
    seedConversation(db, { contactId: 'chris', channel: 'telegram' });
    const commandRegistry = new CommandRegistry();
    const registry = new AdapterRegistry();
    const adapter = makeStubAdapter('telegram', 'telegram');
    registry.register(adapter);
    const fakeChild = new FakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    const cmd = createTorrentCommand({ commandRegistry, db, registry, spawnFn: spawnFn as never });

    await cmd.handler(['magnet:?xt=urn:btih:abc123'], makeCtx(db));
    fakeChild.emit('exit', 0);
    await flush();

    expect(adapter.send).toHaveBeenCalledTimes(1);
    const sent = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.payload.body).toContain('Torrent download complete');
    expect(sent.recipient).toBe('contact:chris');

    const rows = getOutboundRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toContain('Torrent download complete');
    expect(JSON.parse(rows[0]!.metadata)).toEqual({
      command_response: true,
      command: 'torrent',
      torrent_notification: true,
    });
  });

  it('sends a distinct failure notification when the download exits non-zero', async () => {
    const db = makeDb();
    seedConversation(db, { contactId: 'chris', channel: 'telegram' });
    const commandRegistry = new CommandRegistry();
    const registry = new AdapterRegistry();
    const adapter = makeStubAdapter('telegram', 'telegram');
    registry.register(adapter);
    const fakeChild = new FakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    const cmd = createTorrentCommand({ commandRegistry, db, registry, spawnFn: spawnFn as never });

    await cmd.handler(['magnet:?xt=urn:btih:abc123'], makeCtx(db));
    fakeChild.emit('exit', 1);
    await flush();

    expect(adapter.send).toHaveBeenCalledTimes(1);
    const sent = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.payload.body).toContain('Torrent download failed (exit code 1)');
    expect(sent.payload.body).toContain('logs/torrents/');
  });

  it('logs a warning and does not throw when no adapter is registered for the channel', async () => {
    const db = makeDb();
    seedConversation(db, { contactId: 'chris', channel: 'telegram' });
    const commandRegistry = new CommandRegistry();
    const registry = new AdapterRegistry(); // no adapters registered
    const fakeChild = new FakeChild();
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    const cmd = createTorrentCommand({ commandRegistry, db, registry, spawnFn: spawnFn as never });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await cmd.handler(['magnet:?xt=urn:btih:abc123'], makeCtx(db));
    expect(() => fakeChild.emit('exit', 0)).not.toThrow();
    await flush();

    expect(warnSpy).toHaveBeenCalled();
    expect(getOutboundRows(db)).toHaveLength(0);

    warnSpy.mockRestore();
  });
});
