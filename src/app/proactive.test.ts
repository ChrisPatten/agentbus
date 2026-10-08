import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { DeliveryWorker } from '../core/delivery.js';
import { AppAdapter } from '../adapters/app.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { normalize } from '../pipeline/stages/normalize.js';
import { createRouteResolve } from '../pipeline/stages/route-resolve.js';
import { createTranscriptLog } from '../pipeline/stages/transcript-log.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { CommandRegistry } from '../commands/registry.js';
import { createAppSession, eventBounds, listSessions, readEvents } from './store.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';

const config = {
  bus: { http_port: 3000, db_path: ':memory:', log_level: 'info' },
  adapters: { app: { enabled: true } },
  contacts: { alice: { id: 'alice', displayName: 'Alice', platforms: { app: { token: 'app-contact-token-0123456789' } } } },
  topics: ['general'],
  memory: { session_idle_threshold_ms: 900_000 },
  scheduler: { enabled: true, tick_interval_ms: 30_000 },
  schedules: [],
  pipeline: { drop_unrouted: false, routes: [
    { match: { channel: 'app' }, target: { adapterId: 'cc-headless', recipientId: 'agent:work' } },
  ] },
} as unknown as AppConfig;

describe('scheduled work notifying the app while the client is offline', () => {
  for (const target of ['Main', 'named topic'] as const) {
    it(`keeps the scheduled turn hidden and replays one ${target} notification after restart`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agentbus-e61-'));
      const path = join(dir, 'bus.db');
      let db: Database.Database | undefined;
      try {
        db = new Database(path);
        db.pragma('foreign_keys = ON');
        runMigrations(db);
        const queue = new MessageQueue(db);
        const registry = new AdapterRegistry();
        registry.register(new AppAdapter(db, () => 'agent:work'));
        const pipeline = new PipelineEngine();
        pipeline.use({ slot: 10, name: 'normalize', stage: normalize });
        pipeline.use({ slot: 70, name: 'route', stage: createRouteResolve(config, db) });
        pipeline.use({ slot: 80, name: 'transcript', stage: createTranscriptLog(db, config) });

        let topic = 'general';
        let destinationSessionId: string | undefined;
        if (target === 'named topic') {
          const session = createAppSession(db, 'alice', 'agent:work', 'Travel');
          topic = session.topic;
          destinationSessionId = session.sessionId;
        }
        const cursorBeforeWork = eventBounds(db, 'alice').latest;

        const scheduleId = randomUUID();
        db.prepare(`INSERT INTO scheduled_items
          (id,type,timezone,fire_at,channel,sender,payload_body,topic,priority,created_at,created_by,status)
          VALUES (?,'once','UTC',?,'app','contact:alice',?,'sched:report','normal',?,'test','active')`)
          .run(scheduleId, new Date(Date.now() - 60_000).toISOString(),
            'Prepare the report in this scheduled turn.', new Date().toISOString());
        const scheduler = new Scheduler({ db, config, queue, pipeline, registry,
          commandRegistry: new CommandRegistry(), pauseSet: new Set() });
        await scheduler.tick();
        const scheduled = db.prepare(`SELECT s.id, cr.topic, t.metadata FROM sessions s
          JOIN conversation_registry cr ON cr.id = s.conversation_id
          JOIN transcripts t ON t.session_id = s.id
          WHERE json_extract(t.metadata, '$.schedule_id') = ?`).get(scheduleId) as
          {id:string;topic:string;metadata:string}|undefined;
        expect(scheduled?.topic).toBe('sched:report');
        expect(JSON.parse(scheduled!.metadata)).toMatchObject({ scheduled: true, schedule_id: scheduleId });
        expect(listSessions(db, 'alice', 'agent:work', 'all', 20).some(s => s['session_id'] === scheduled!.id)).toBe(false);

        // The scheduled agent turn sends an operator-facing update. No HTTP
        // server or app socket exists: DeliveryWorker must still persist and ACK.
        const outbound: MessageEnvelope = {
          id: randomUUID(), timestamp: new Date().toISOString(), channel: 'app', topic,
          sender: 'agent:work', recipient: 'contact:alice', reply_to: null,
          priority: 'normal', payload: { type: 'text', body: 'The report is ready.' }, metadata: {},
        };
        queue.enqueue(outbound);
        const pending = queue.dequeueByPrefix('contact:', 10);
        expect(pending).toHaveLength(1);
        const worker = new DeliveryWorker({ queue, registry, db });
        await (worker as unknown as {deliver(id:string, envelope:MessageEnvelope):Promise<void>})
          .deliver(outbound.id, pending[0]!.envelope);
        expect((db.prepare('SELECT status FROM message_queue WHERE id = ?').get(outbound.id) as {status:string}).status)
          .toBe('delivered');

        db.close();
        db = new Database(path);
        db.pragma('foreign_keys = ON');
        runMigrations(db);
        const visible = listSessions(db, 'alice', 'agent:work', 'all', 20);
        expect(visible.some(s => s['session_id'] === scheduled!.id)).toBe(false);
        const replay = readEvents(db, 'alice', 'agent:work', cursorBeforeWork, eventBounds(db, 'alice').latest);
        const messages = replay.filter(e => e.event === 'message' && e.data['message_id'] === outbound.id);
        expect(messages).toHaveLength(1);
        expect(messages[0]!.data).toMatchObject({ body: 'The report is ready.', direction: 'outbound' });
        const destination = visible.find(s => s['session_id'] === messages[0]!.data['session_id']);
        expect(destination).toMatchObject({ title: target === 'Main' ? 'Main' : 'Travel', topic });
        if (destinationSessionId) expect(destination?.['session_id']).toBe(destinationSessionId);
        expect(replay.every(e => e.data['session_id'] !== scheduled!.id)).toBe(true);
      } finally {
        db?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
