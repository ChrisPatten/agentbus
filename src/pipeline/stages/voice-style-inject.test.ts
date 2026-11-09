import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/schema.js';
import { createVoiceStyleInject } from './voice-style-inject.js';
import { SYSTEM_BLOCKS_KEY } from '../../core/system-block.js';
import type { AppConfig } from '../../config/schema.js';
import type { PipelineContext } from '../types.js';

describe('voice-style-inject stage (E102)', () => {
  let db: Database.Database; let dir: string; let file: string; let styleFile: string;
  const speech = { style_file: '' };
  const config = () => ({ adapters: { intercom: { voice: { speech } } } }) as unknown as AppConfig;
  const ctx = (o: { sessionId?: string | null; input?: string; recipient?: string; slash?: boolean } = {}): PipelineContext => ({
    envelope: { id: 'm', timestamp: '', channel: 'telegram:peggy', topic: 'general', sender: 'contact:chris', recipient: '', reply_to: null, priority: 'normal',
      payload: { type: 'text', body: 'hi' }, metadata: { origin: 'intercom', ...(o.input === undefined ? { input: 'voice' } : o.input ? { input: o.input } : {}) } },
    contact: null, dedupKey: null, isSlashCommand: o.slash ?? false, slashCommand: null, topics: [], priorityScore: 0,
    routes: [{ adapterId: 'cc-pool', recipientId: o.recipient ?? 'agent:peggy-pool-1' }, { adapterId: 'telegram', recipientId: 'contact:chris' }],
    conversationId: 'conv', sessionId: o.sessionId === undefined ? 'sess-1' : o.sessionId, sessionCreated: false, config: config(), db,
  });
  const blocks = (c: PipelineContext) => (c.envelope.metadata[SYSTEM_BLOCKS_KEY] as { text: string; recipient?: string }[] | undefined) ?? [];

  beforeEach(() => {
    db = new Database(':memory:'); runMigrations(db);
    dir = mkdtempSync(join(tmpdir(), 'vstyle-')); file = join(dir, 'voice-style.md'); styleFile = file; speech.style_file = file;
    writeFileSync(file, 'Speak like a secretary.');
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('injects on the first voice message of a session, for that agent route only, and not again', async () => {
    const stage = createVoiceStyleInject(db, config(), () => {});
    const a = await stage(ctx()) as PipelineContext;
    expect(blocks(a)).toHaveLength(1);
    expect(blocks(a)[0]).toMatchObject({ recipient: 'agent:peggy-pool-1' });
    expect(blocks(a)[0]!.text).toContain('Speak like a secretary.');
    expect(blocks(a)[0]!.text).toContain('kind="voice-style"');
    const b = await stage(ctx()) as PipelineContext;
    expect(blocks(b)).toHaveLength(0);
  });
  it('injects again for a new session, another pane, and a changed file', async () => {
    const stage = createVoiceStyleInject(db, config(), () => {});
    await stage(ctx());
    expect(blocks(await stage(ctx({ sessionId: 'sess-2' })) as PipelineContext)).toHaveLength(1);
    expect(blocks(await stage(ctx({ recipient: 'agent:peggy-pool-2' })) as PipelineContext)).toHaveLength(1);
    expect(blocks(await stage(ctx()) as PipelineContext)).toHaveLength(0);
    writeFileSync(file, 'Speak like a secretary. Be brief.');
    const changed = await stage(ctx()) as PipelineContext;
    expect(blocks(changed)[0]!.text).toContain('Be brief.');
    expect(blocks(await stage(ctx()) as PipelineContext)).toHaveLength(0);
  });
  it('survives a restart: state is in the database', async () => {
    await createVoiceStyleInject(db, config(), () => {})(ctx());
    expect(blocks(await createVoiceStyleInject(db, config(), () => {})(ctx()) as PipelineContext)).toHaveLength(0);
  });
  it('does nothing for typed messages, slash commands, a missing file or an unset path', async () => {
    const stage = createVoiceStyleInject(db, config(), () => {});
    expect(blocks(await stage(ctx({ input: '' })) as PipelineContext)).toHaveLength(0);
    expect(blocks(await stage(ctx({ slash: true })) as PipelineContext)).toHaveLength(0);
    speech.style_file = join(dir, 'nope.md');
    expect(blocks(await stage(ctx()) as PipelineContext)).toHaveLength(0);
    speech.style_file = '';
    expect(blocks(await stage(ctx()) as PipelineContext)).toHaveLength(0);
    // and none of that marked the session as injected
    speech.style_file = file;
    expect(blocks(await stage(ctx()) as PipelineContext)).toHaveLength(1);
  });
});
