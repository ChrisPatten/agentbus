/**
 * Email adapter — platform adapter for AgentBus (E21).
 *
 * Runs in-process with bus-core. Implements AdapterInstance so bus-core can
 * register it in the AdapterRegistry and dispatch outbound replies directly.
 *
 * Inbound: connects over IMAP and uses IDLE (push) to receive new mail near
 * instantly. Each message is parsed, allowlist- and authentication-checked, then
 * submitted to the pipeline via the shared processInbound() function (no HTTP
 * hop). Each email thread maps to a stable `thread:<hash>` topic so it becomes
 * its own long-lived conversation/session (E20).
 *
 * Outbound: bus-core's delivery worker calls send(envelope). The adapter looks
 * the thread up by (channel, topic) and sends a properly-threaded SMTP reply
 * (In-Reply-To / References / `Re:` subject / original To).
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { dkimVerify } from 'mailauth';
import type Database from 'better-sqlite3';
import type { MessageEnvelope } from '../types/envelope.js';
import type {
  AdapterInstance,
  AdapterCapabilities,
  DeliveryResult,
  HealthStatus,
  AdapterRegistry,
} from '../core/registry.js';
import type { AppConfig, EmailInstanceConfig } from '../config/schema.js';
import { processInbound, type InboundMessage, type Attachment } from '../http/api.js';
import { resolveMediaConfig, persistAttachmentBuffer } from '../media/attachments.js';
import type { MessageQueue } from '../core/queue.js';
import type { PipelineEngine } from '../pipeline/engine.js';
import type { CommandRegistry } from '../commands/registry.js';
import {
  normalizeMessageId,
  parseReferences,
  deriveThreadKey,
  topicForThreadKey,
  baseSubject,
  replySubject,
  buildReferencesChain,
  selectInboundBody,
  isSenderAuthenticated,
  dkimAuthenticated,
} from './email-thread.js';
import { renderEmail, resolveInboundText } from './email-render.js';

const BACKOFF_INITIAL_MS = 2000;
const BACKOFF_MAX_MS = 60_000;
const LOOP_RESTART_DELAY_MS = 5000;

export interface EmailAdapterDeps {
  config: AppConfig;
  queue: MessageQueue;
  pipeline: PipelineEngine;
  db: Database.Database;
  registry?: AdapterRegistry;
  commandRegistry?: CommandRegistry;
  pauseSet?: Set<string>;
  /** Account name used as the adapter id suffix (e.g. "peggy" → id "email:peggy"). */
  instanceName?: string;
  /** Pre-resolved per-instance config from getEmailInstances(). */
  instanceConfig: EmailInstanceConfig;
}

/**
 * Reference to an inline (HTML-embedded) attachment surfaced to the agent in
 * `metadata.inline_attachments`. Only the id is needed to fetch it on demand
 * via the `fetch_attachment` tool; the path is not exposed inline.
 */
interface InlineAttachmentRef {
  id: string;
  type: 'image' | 'file';
  mime_type?: string;
  original_filename?: string;
}

/** Persisted per-thread reply metadata (mirrors the email_threads table). */
interface ThreadRow {
  channel: string;
  topic: string;
  thread_key: string;
  subject: string | null;
  last_inbound_message_id: string | null;
  references_chain: string | null;
  contact_address: string | null;
  updated_at: string;
}

export class EmailAdapter implements AdapterInstance {
  readonly id: string;
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  private readonly deps: EmailAdapterDeps;
  private readonly cfg: EmailInstanceConfig;
  private readonly tag: string;
  private readonly from: string;

  /** Lowercased sender addresses allowed to reach the agent (the allowlist). */
  private readonly allowedSenders = new Set<string>();
  /** Map from contact id → their first configured email address (outbound fallback). */
  private readonly contactAddressMap = new Map<string, string>();

  private readonly transport: Transporter;
  private client: ImapFlow | null = null;
  private stopping = false;
  private stopController = new AbortController();
  /** Highest IMAP UID already processed; new mail has a higher UID. */
  private lastUid = 0;
  /** Serializes fetches triggered by overlapping `exists` events. */
  private fetchChain: Promise<void> = Promise.resolve();
  private lastActivity: string | null = null;
  private consecutiveFailures = 0;

  constructor(deps: EmailAdapterDeps) {
    this.deps = deps;
    this.cfg = deps.instanceConfig;
    this.id = deps.instanceName ? `email:${deps.instanceName}` : 'email';
    this.name = this.id;
    this.tag = `[${this.id}]`;
    this.capabilities = {
      send: true,
      react: false,
      markRead: false,
      typing: false,
      registerCommands: false,
      // Email has no practical body length cap; never split.
      maxMessageLength: 5_000_000,
      channels: [this.id],
    };

    this.from = this.cfg.smtp.from ?? this.cfg.imap.user;

    this.transport = nodemailer.createTransport({
      host: this.cfg.smtp.host,
      port: this.cfg.smtp.port,
      secure: this.cfg.smtp.secure,
      auth: {
        user: this.cfg.smtp.user ?? this.cfg.imap.user,
        pass: this.cfg.smtp.password ?? this.cfg.imap.password,
      },
    });

    // Build the allowlist + outbound address map from configured contacts.
    for (const contact of Object.values(deps.config.contacts)) {
      const email = contact.platforms.email;
      if (!email) continue;
      const addrs = Array.isArray(email.address) ? email.address : [email.address];
      for (const a of addrs) this.allowedSenders.add(a.toLowerCase());
      if (addrs[0]) this.contactAddressMap.set(contact.id, addrs[0]);
    }
  }

  // ── AdapterInstance lifecycle ─────────────────────────────────────────────

  async start(): Promise<void> {
    console.log(
      `${this.tag} Adapter starting — mailbox ${this.cfg.imap.user}/${this.cfg.imap.mailbox}, ` +
        `allowed senders: [${[...this.allowedSenders].join(', ')}], require_auth=${this.cfg.require_auth}`,
    );
    void this.supervise('imapLoop', () => this.connectAndListen());
    console.log(`${this.tag} Adapter started`);
  }

  async stop(): Promise<void> {
    console.log(`${this.tag} Stopping`);
    this.stopping = true;
    this.stopController.abort();
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        /* best-effort */
      }
    }
    this.transport.close();
  }

  async health(): Promise<HealthStatus> {
    if (this.consecutiveFailures >= 5) {
      return {
        status: 'unhealthy',
        lastActivity: this.lastActivity ?? undefined,
        details: { consecutiveFailures: this.consecutiveFailures },
      };
    }
    if (this.consecutiveFailures >= 2) {
      return {
        status: 'degraded',
        lastActivity: this.lastActivity ?? undefined,
        details: { consecutiveFailures: this.consecutiveFailures },
      };
    }
    return { status: 'healthy', lastActivity: this.lastActivity ?? undefined };
  }

  // ── AdapterInstance send (SMTP, threaded) ─────────────────────────────────

  async send(envelope: MessageEnvelope): Promise<DeliveryResult> {
    if (envelope.payload.type !== 'text') {
      return { success: false, error: `Unsupported payload type: ${envelope.payload.type}`, retryable: false };
    }

    const thread = this.getThread(envelope.topic);

    let to: string | undefined;
    let subject: string;
    let inReplyTo: string | undefined;
    let references: string[] | undefined;

    if (thread) {
      to = thread.contact_address ?? this.contactAddressFor(envelope.recipient);
      subject = replySubject(thread.subject ?? '');
      if (thread.last_inbound_message_id) inReplyTo = `<${thread.last_inbound_message_id}>`;
      if (thread.references_chain) references = thread.references_chain.split(/\s+/).filter(Boolean);
    } else {
      // No thread row (e.g. an agent-initiated message via the send_email tool).
      // The exact target address is carried in metadata.email_to when present
      // (the recipient field is a `contact:` ref so the delivery worker dispatches
      // it); otherwise resolve the recipient (raw address or contact ref).
      const explicitTo =
        typeof envelope.metadata['email_to'] === 'string'
          ? (envelope.metadata['email_to'] as string)
          : undefined;
      const resolved = this.resolveOutboundAddress(explicitTo ?? envelope.recipient);
      if (resolved.error) {
        return { success: false, error: resolved.error, retryable: false };
      }
      to = resolved.address;
      const explicitSubject =
        typeof envelope.metadata['email_subject'] === 'string'
          ? (envelope.metadata['email_subject'] as string).trim()
          : '';
      subject = explicitSubject || 'Message from your assistant';
    }

    if (!to) {
      return {
        success: false,
        error:
          `No email address for recipient "${envelope.recipient}" on topic "${envelope.topic}" ` +
          `(no thread row and no configured contact address)`,
        retryable: false,
      };
    }

    // Render the agent's Markdown to rich-text HTML, sent multipart/alternative
    // with the original Markdown as the plain-text fallback.
    const { html, text } = renderEmail(envelope.payload.body);

    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to,
        subject,
        text,
        html,
        inReplyTo,
        references,
      });
      this.lastActivity = new Date().toISOString();
      // Record our own Message-ID in the thread chain so later replies stay linked.
      if (thread && info.messageId) {
        this.appendSentMessageId(envelope.topic, normalizeMessageId(info.messageId));
      }
      return { success: true, platformMessageId: info.messageId };
    } catch (err) {
      return { success: false, error: `SMTP send failed: ${String(err)}`, retryable: true };
    }
  }

  private contactAddressFor(recipient: string): string | undefined {
    const id = recipient.startsWith('contact:') ? recipient.slice('contact:'.length) : recipient;
    return this.contactAddressMap.get(id);
  }

  /**
   * Resolve an agent-initiated send's recipient to a deliverable address. A raw
   * email address (from the send_email tool) is allowed only if it is on the
   * allowlist — the same gate the inbound path enforces — so the agent can never
   * email an arbitrary recipient. A `contact:` reference resolves via the address
   * map (already drawn from the allowlist).
   */
  private resolveOutboundAddress(recipient: string): { address?: string; error?: string } {
    if (recipient.includes('@')) {
      const addr = recipient.toLowerCase();
      if (!this.allowedSenders.has(addr)) {
        return {
          error: `Refusing to send to "${recipient}" — not on the email allowlist`,
        };
      }
      return { address: recipient };
    }
    return { address: this.contactAddressFor(recipient) };
  }

  // ── Inbound: IMAP connect + IDLE listen ───────────────────────────────────

  private async connectAndListen(): Promise<void> {
    const client = new ImapFlow({
      host: this.cfg.imap.host,
      port: this.cfg.imap.port,
      secure: this.cfg.imap.secure,
      auth: { user: this.cfg.imap.user, pass: this.cfg.imap.password },
      logger: false,
      // imapflow maintains IDLE automatically when no command is running.
    });
    this.client = client;
    client.on('error', (err: unknown) => {
      console.error(`${this.tag} IMAP client error: ${String(err)}`);
    });

    await client.connect();
    const mailbox = await client.mailboxOpen(this.cfg.imap.mailbox);
    // Start watching after existing mail: only act on messages that arrive now.
    this.lastUid = Math.max(0, Number(mailbox.uidNext ?? 1) - 1);
    this.consecutiveFailures = 0;
    console.log(`${this.tag} Connected — watching ${this.cfg.imap.mailbox} for uid > ${this.lastUid}`);

    const onExists = (): void => this.scheduleFetch(client);
    client.on('exists', onExists);

    // Block until the connection closes or we shut down, so supervise() can
    // reconnect on an unexpected drop.
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('close', () => reject(new Error('IMAP connection closed')));
        if (this.stopController.signal.aborted) {
          resolve();
          return;
        }
        this.stopController.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally {
      client.removeListener('exists', onExists);
    }
  }

  /** Chain a fetch after any in-flight one so overlapping `exists` don't race. */
  private scheduleFetch(client: ImapFlow): void {
    this.fetchChain = this.fetchChain
      .then(() => this.fetchNew(client))
      .catch((err: unknown) => console.error(`${this.tag} Fetch error: ${String(err)}`));
  }

  private async fetchNew(client: ImapFlow): Promise<void> {
    if (this.stopping) return;
    // `*` always matches the last message, so guard each uid against lastUid.
    const range = `${this.lastUid + 1}:*`;
    for await (const msg of client.fetch({ uid: range }, { uid: true, source: true })) {
      if (this.stopping) return;
      if (msg.uid <= this.lastUid) continue;
      this.lastUid = Math.max(this.lastUid, msg.uid);
      if (!msg.source) continue;
      try {
        await this.handleRawMessage(msg.source);
      } catch (err) {
        console.error(`${this.tag} Failed to handle message uid ${msg.uid}: ${String(err)}`);
      }
    }
  }

  /** Collect every `Authentication-Results` header value (the header can repeat). */
  private collectAuthResults(parsed: ParsedMail): string[] {
    return parsed.headerLines
      .filter((h) => h.key === 'authentication-results')
      .map((h) => h.line.replace(/^[^:]*:/, '').trim());
  }

  /**
   * Verify the message's DKIM signature(s) against DNS (no reliance on a
   * receiving-server header). Authentic when at least one signature passes and
   * aligns with the From domain. Returns false on any error (DNS failure, no
   * signature, etc.) — fail closed.
   */
  private async verifyDkim(raw: Buffer): Promise<boolean> {
    try {
      const { results } = await dkimVerify(raw);
      const ok = dkimAuthenticated(
        results.map((r) => ({ result: r.status.result, aligned: r.status.aligned })),
      );
      if (!ok) {
        // Diagnostic: surface exactly why each signature failed to authenticate.
        const detail = results.length
          ? results
              .map(
                (r) =>
                  `${r.signingDomain ?? '?'} result=${r.status.result} aligned=${String(r.status.aligned)}` +
                  (r.status.comment ? ` (${r.status.comment})` : ''),
              )
              .join('; ')
          : '(no DKIM-Signature found in message)';
        console.warn(`${this.tag} DKIM did not authenticate: ${detail}`);
      }
      return ok;
    } catch (err) {
      console.warn(`${this.tag} DKIM verification error: ${String(err)}`);
      return false;
    }
  }

  private async handleRawMessage(raw: Buffer): Promise<void> {
    const parsed = await simpleParser(raw);

    const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase();
    if (!fromAddr) {
      console.log(`${this.tag} Dropped message with no From address`);
      return;
    }

    // Allowlist: only known senders reach the agent.
    if (!this.allowedSenders.has(fromAddr)) {
      console.log(`${this.tag} Dropped message from unknown sender ${fromAddr}`);
      return;
    }

    // Anti-spoofing. Two layers, cheap first:
    //   1. Trust a receiving-server Authentication-Results header if present and
    //      passing (the fast path for providers like Gmail that stamp it).
    //   2. Otherwise verify the message's DKIM signature ourselves against DNS.
    //      Necessary because some providers (e.g. iCloud, for intra-provider
    //      delivery) never stamp Authentication-Results, yet the mail is still
    //      DKIM-signed and verifiable. This makes the check provider-independent.
    if (this.cfg.require_auth) {
      const fromDomain = fromAddr.split('@')[1] ?? '';
      const authResults = this.collectAuthResults(parsed);
      let authed = isSenderAuthenticated(authResults, fromDomain);
      if (!authed) authed = await this.verifyDkim(raw);
      if (!authed) {
        console.warn(
          `${this.tag} Dropped UNAUTHENTICATED message from ${fromAddr} (require_auth=true). ` +
            `From domain: ${fromDomain}. Authentication-Results: ` +
            (authResults.length ? authResults.map((r) => `[${r}]`).join(' ') : '(none present)') +
            `; DKIM did not verify+align.`,
        );
        return;
      }
    }

    // Threading.
    const references = parseReferences(parsed.references);
    const inReplyTo = normalizeMessageId(parsed.inReplyTo);
    const messageId = normalizeMessageId(parsed.messageId);
    const threadKey = deriveThreadKey({ references, inReplyTo, messageId });
    const topic = topicForThreadKey(threadKey);
    const subject = parsed.subject ?? '(no subject)';

    // Persist reply metadata so send() can thread the agent's response.
    this.upsertThread({
      topic,
      threadKey,
      subject: baseSubject(subject),
      lastInboundMessageId: messageId,
      referencesChain: buildReferencesChain(references, messageId),
      contactAddress: fromAddr,
    });

    // Classify reply vs. forward. A forward is detected by its `Fwd:` subject or a
    // forwarded-message marker in the body — this also overrides any References a
    // forwarding client might carry, so a forward is never mistaken for a reply.
    const textPart = parsed.text ?? '';
    const isForward =
      /^\s*(fwd?|fw):/i.test(subject) ||
      /(^|\n)\s*(begin forwarded message:|-{2,}\s*forwarded message\s*-{2,})/i.test(textPart);
    const isThreadedReply = (inReplyTo !== '' || references.length > 0) && !isForward;

    // Resolve the body text. For a forward / new thread, prefer the HTML conversion:
    // forwarded HTML mail often has an empty (header-only) text/plain part while the
    // payload lives only in the HTML. For a threaded reply, use the text/plain part
    // so quoted history can be stripped (its earlier turns already live in the
    // session); a new thread keeps its full body so the forwarded content survives.
    const rawText = resolveInboundText({
      text: textPart,
      html: parsed.html,
      preferHtml: !isThreadedReply,
    });
    const body = selectInboundBody(rawText, isThreadedReply);
    const effectiveBody = body || `[Email with no text body] Subject: ${subject}`;

    // File attachments (E22). mailparser decodes attachment bytes into
    // `attachment.content`, so there is no network fetch (unlike Telegram).
    // Real attachments are surfaced to the agent like Telegram files/images;
    // inline (HTML-embedded, `related`) images — signature logos and the like —
    // are persisted but kept out of the agent's context to avoid noise, and are
    // retrievable on demand via the `fetch_attachment` MCP tool.
    const { attachments, inlineAttachments } = this.persistAttachments(parsed.attachments);

    const message: InboundMessage = {
      channel: this.id,
      sender: fromAddr,
      topic,
      payload: { type: 'text', body: effectiveBody },
      metadata: {
        email_message_id: messageId,
        email_subject: subject,
        email_from: fromAddr,
        email_is_forward: isForward,
        platform_message_id: messageId,
      },
    };
    if (attachments.length > 0) message.attachments = attachments;
    if (inlineAttachments.length > 0) message.metadata!['inline_attachments'] = inlineAttachments;

    await processInbound(message, this.deps);
    this.lastActivity = new Date().toISOString();
    console.log(`${this.tag} Delivered mail from ${fromAddr} (thread ${topic})`);
  }

  /**
   * Persist parsed email attachments to disk + the `attachments` table.
   * Splits them into `attachments` (real attachments, surfaced to the agent)
   * and `inlineAttachments` (HTML-embedded images, fetchable on demand).
   *
   * Never throws — a per-attachment failure is logged and skipped so the mail
   * is always delivered. Returns empty lists when no agent with a media config
   * is routed from this channel (a warning is logged).
   */
  private persistAttachments(parsedAttachments: ParsedMail['attachments']): {
    attachments: Attachment[];
    inlineAttachments: InlineAttachmentRef[];
  } {
    const attachments: Attachment[] = [];
    const inlineAttachments: InlineAttachmentRef[] = [];
    if (!parsedAttachments || parsedAttachments.length === 0) {
      return { attachments, inlineAttachments };
    }

    const media = resolveMediaConfig(this.deps.config, this.id);
    if (!media) {
      console.warn(
        `${this.tag} Received ${parsedAttachments.length} attachment(s) but no agent with media config is routed from channel "${this.id}" — skipping`,
      );
      return { attachments, inlineAttachments };
    }

    for (const att of parsedAttachments) {
      if (!Buffer.isBuffer(att.content)) continue;
      const mimeType = att.contentType || undefined;
      const filename = att.filename || undefined;
      const kind: 'image' | 'file' = mimeType?.startsWith('image/') ? 'image' : 'file';
      try {
        const { id, local_path } = persistAttachmentBuffer(this.deps.db, media, att.content, {
          mime_type: mimeType,
          original_filename: filename,
        });
        // mailparser sets `related: true` for parts inside multipart/related
        // (HTML-embedded), and `contentDisposition: 'inline'` for cid parts.
        const isInline = att.related === true || att.contentDisposition === 'inline';
        if (isInline) {
          const ref: InlineAttachmentRef = { id, type: kind };
          if (mimeType) ref.mime_type = mimeType;
          if (filename) ref.original_filename = filename;
          inlineAttachments.push(ref);
        } else {
          const a: Attachment = { type: kind, local_path };
          if (mimeType) a.mime_type = mimeType;
          if (filename) a.original_filename = filename;
          attachments.push(a);
        }
      } catch (err) {
        console.error(`${this.tag} Attachment persist failed: ${String(err)}`);
      }
    }

    return { attachments, inlineAttachments };
  }

  // ── Thread persistence ─────────────────────────────────────────────────────

  private getThread(topic: string): ThreadRow | null {
    return (
      (this.deps.db
        .prepare(`SELECT * FROM email_threads WHERE channel = ? AND topic = ?`)
        .get(this.id, topic) as ThreadRow | undefined) ?? null
    );
  }

  private upsertThread(t: {
    topic: string;
    threadKey: string;
    subject: string;
    lastInboundMessageId: string;
    referencesChain: string;
    contactAddress: string;
  }): void {
    this.deps.db
      .prepare(
        `INSERT INTO email_threads
           (channel, topic, thread_key, subject, last_inbound_message_id, references_chain, contact_address, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, topic) DO UPDATE SET
           subject = excluded.subject,
           last_inbound_message_id = excluded.last_inbound_message_id,
           references_chain = excluded.references_chain,
           contact_address = excluded.contact_address,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.id,
        t.topic,
        t.threadKey,
        t.subject,
        t.lastInboundMessageId,
        t.referencesChain,
        t.contactAddress,
        new Date().toISOString(),
      );
  }

  /** Append our outbound Message-ID to a thread's References chain. */
  private appendSentMessageId(topic: string, sentMessageId: string): void {
    const thread = this.getThread(topic);
    if (!thread || !sentMessageId) return;
    const existing = thread.references_chain ?? '';
    if (existing.includes(`<${sentMessageId}>`)) return;
    const updated = existing ? `${existing} <${sentMessageId}>` : `<${sentMessageId}>`;
    this.deps.db
      .prepare(`UPDATE email_threads SET references_chain = ?, updated_at = ? WHERE channel = ? AND topic = ?`)
      .run(updated, new Date().toISOString(), this.id, topic);
  }

  // ── Loop supervision ──────────────────────────────────────────────────────

  private async supervise(name: string, fn: () => Promise<void>): Promise<void> {
    let backoff = BACKOFF_INITIAL_MS;
    while (!this.stopping) {
      try {
        await fn();
        backoff = BACKOFF_INITIAL_MS;
      } catch (err) {
        this.consecutiveFailures++;
        console.error(`${this.tag} ${name} crashed: ${String(err)}`);
        if (!this.stopping) {
          console.error(`${this.tag} Reconnecting ${name} in ${backoff}ms`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        }
      }
    }
    console.log(`${this.tag} ${name} stopped`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.stopController.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
