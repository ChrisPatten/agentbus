import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EmailAdapter } from './email.js';
import { runMigrations } from '../db/schema.js';
import type { AppConfig, EmailInstanceConfig } from '../config/schema.js';
import type { MessageQueue } from '../core/queue.js';
import type { PipelineEngine } from '../pipeline/engine.js';

// ── Test config ───────────────────────────────────────────────────────────────

function makeEmailConfig(tmpDownloadDir: string, withMedia = true): AppConfig {
  return {
    bus: { http_port: 3000, db_path: ':memory:', log_level: 'info' },
    adapters: {},
    contacts: {
      chris: {
        id: 'chris',
        displayName: 'Chris',
        platforms: { email: { address: 'chris@example.com' } },
      },
    },
    topics: ['general'],
    agents: withMedia
      ? { 'agent:claude': { media: { download_path: tmpDownloadDir, ttl_seconds: 3600 } } }
      : {},
    memory: {
      summarizer_interval_ms: 60000,
      session_idle_threshold_ms: 1800000,
      context_window_hours: 48,
      claude_api_model: 'claude-opus-4-6',
      summary_max_tokens: 8192,
      session_close_min_messages: 0,
      memory_inject_exclude: [],
    },
    scheduler: { tick_interval_ms: 30000, enabled: true },
    schedules: [],
    pipeline: {
      dedup_window_ms: 30000,
      drop_unrouted: false,
      topic_rules: [],
      priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
      urgency_keywords: [],
      vip_contacts: [],
      routes: [{ match: { channel: 'email' }, target: { adapterId: 'cc', recipientId: 'agent:claude' } }],
    },
  } as unknown as AppConfig;
}

const instanceConfig: EmailInstanceConfig = {
  name: null,
  imap: { host: 'imap.test', port: 993, user: 'agent@example.com', password: 'pw', mailbox: 'INBOX', secure: true },
  smtp: { host: 'smtp.test', port: 587, secure: false },
  // Skip DKIM/SPF so hand-built test mail is accepted.
  require_auth: false,
} as unknown as EmailInstanceConfig;

// ── Raw MIME builders ───────────────────────────────────────────────────────

const CRLF = '\r\n';

/** A multipart/mixed message with a single real (Content-Disposition: attachment) part. */
function rawWithAttachment(content: Buffer, filename: string, contentType: string): Buffer {
  const b64 = content.toString('base64');
  const lines = [
    'From: Chris <chris@example.com>',
    'To: agent@example.com',
    'Subject: Has a file',
    'Message-ID: <m-attach@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Here is the report.',
    '--BOUND',
    `Content-Type: ${contentType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '--BOUND--',
    '',
  ];
  return Buffer.from(lines.join(CRLF), 'utf-8');
}

/** A multipart/related message with an HTML body referencing an inline cid image. */
function rawWithInlineImage(content: Buffer, filename: string): Buffer {
  const b64 = content.toString('base64');
  const lines = [
    'From: Chris <chris@example.com>',
    'To: agent@example.com',
    'Subject: Has an inline logo',
    'Message-ID: <m-inline@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="REL"',
    '',
    '--REL',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Hello from my signature</p><img src="cid:logo@example.com">',
    '--REL',
    `Content-Type: image/png; name="${filename}"`,
    `Content-Disposition: inline; filename="${filename}"`,
    'Content-ID: <logo@example.com>',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '--REL--',
    '',
  ];
  return Buffer.from(lines.join(CRLF), 'utf-8');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EmailAdapter inbound attachment handling', () => {
  let db: Database.Database;
  let tmpDir: string;
  let processInboundCalls: Array<Record<string, unknown>>;

  function makeAdapter(config: AppConfig): EmailAdapter {
    processInboundCalls = [];
    const pipeline = {
      process: async (ctx: { envelope: Record<string, unknown> }) => {
        processInboundCalls.push(ctx.envelope);
        return null; // abort before the queue
      },
    } as unknown as PipelineEngine;
    const queue = {} as unknown as MessageQueue;
    return new EmailAdapter({ config, queue, pipeline, db, instanceConfig });
  }

  function deliver(adapter: EmailAdapter, raw: Buffer): Promise<void> {
    return (adapter as unknown as { handleRawMessage: (r: Buffer) => Promise<void> }).handleRawMessage(raw);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentbus-email-test-'));
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists a real attachment, records the row, and attaches it to the envelope', async () => {
    const adapter = makeAdapter(makeEmailConfig(tmpDir));
    const pdf = Buffer.from('%PDF-1.4 fake pdf bytes');
    await deliver(adapter, rawWithAttachment(pdf, 'report.pdf', 'application/pdf'));

    // File written with the buffer's contents
    const files = readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.pdf$/);
    expect(readFileSync(join(tmpDir, files[0]!)).equals(pdf)).toBe(true);

    // DB row inserted with the resolved agent + TTL
    const row = db.prepare(`SELECT * FROM attachments`).get() as {
      agent_id: string;
      mime_type: string;
      original_filename: string;
      created_at: number;
      expires_at: number;
      local_path: string;
    };
    expect(row.agent_id).toBe('agent:claude');
    expect(row.mime_type).toBe('application/pdf');
    expect(row.original_filename).toBe('report.pdf');
    expect(row.expires_at - row.created_at).toBe(3600 * 1000);

    // Envelope carries it as a (rendered) attachment, not inline
    const meta = processInboundCalls[0]!['metadata'] as Record<string, unknown>;
    const attachments = meta['attachments'] as Array<{ type: string; local_path: string; original_filename: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.type).toBe('file');
    expect(attachments[0]!.local_path).toBe(row.local_path);
    expect(attachments[0]!.original_filename).toBe('report.pdf');
    expect(meta['inline_attachments']).toBeUndefined();
  });

  it('persists an inline image but surfaces only an id reference (not in attachments)', async () => {
    const adapter = makeAdapter(makeEmailConfig(tmpDir));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await deliver(adapter, rawWithInlineImage(Buffer.from(png), 'logo.png'));

    // File written + DB row exists (so the sweeper reclaims it at TTL)
    const files = readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    const row = db.prepare(`SELECT id, mime_type FROM attachments`).get() as { id: string; mime_type: string };
    expect(row.mime_type).toBe('image/png');

    const meta = processInboundCalls[0]!['metadata'] as Record<string, unknown>;
    // Not surfaced as a normal attachment
    expect(meta['attachments']).toBeUndefined();
    // Surfaced as an inline reference carrying the id (no path)
    const inline = meta['inline_attachments'] as Array<{ id: string; type: string; original_filename: string }>;
    expect(inline).toHaveLength(1);
    expect(inline[0]!.id).toBe(row.id);
    expect(inline[0]!.type).toBe('image');
    expect(inline[0]!.original_filename).toBe('logo.png');
  });

  it('delivers the message without attachments when no agent media config is routed', async () => {
    const adapter = makeAdapter(makeEmailConfig(tmpDir, /* withMedia */ false));
    await deliver(adapter, rawWithAttachment(Buffer.from('x'), 'report.pdf', 'application/pdf'));

    expect(readdirSync(tmpDir)).toHaveLength(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM attachments`).get()).toEqual({ n: 0 });
    // Message still delivered
    expect(processInboundCalls).toHaveLength(1);
    const meta = processInboundCalls[0]!['metadata'] as Record<string, unknown>;
    expect(meta['attachments']).toBeUndefined();
    expect(meta['inline_attachments']).toBeUndefined();
  });
});
