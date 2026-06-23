/**
 * Pure helpers for the email adapter (E21).
 *
 * Threading, subject handling, quoted-reply stripping, and Authentication-Results
 * parsing — all side-effect-free so they can be unit tested without IMAP/SMTP.
 */
import { createHash } from 'node:crypto';
import { THREAD_TOPIC_PREFIX } from '../pipeline/types.js';

/** Strip surrounding angle brackets and whitespace from a Message-ID. */
export function normalizeMessageId(id: string | null | undefined): string {
  if (!id) return '';
  return id.trim().replace(/^<|>$/g, '').trim();
}

/**
 * Split a raw `References` header (or mailparser's string | string[]) into an
 * ordered list of bare message-ids (no angle brackets), oldest first.
 */
export function parseReferences(refs: string | string[] | null | undefined): string[] {
  if (!refs) return [];
  const raw = Array.isArray(refs) ? refs.join(' ') : refs;
  return raw
    .split(/\s+/)
    .map((t) => normalizeMessageId(t))
    .filter((t) => t.length > 0);
}

/**
 * Derive a stable thread key for a message. The key is the thread root:
 *   - the first id in References (the originating message), else
 *   - the In-Reply-To id (a 2-message thread's root), else
 *   - the message's own Message-ID (a brand-new thread).
 *
 * A forwarded mail is a fresh compose with no References/In-Reply-To, so its key
 * is its own Message-ID → a new thread → a new conversation_id → a new session.
 */
export function deriveThreadKey(opts: {
  references: string[];
  inReplyTo: string;
  messageId: string;
}): string {
  if (opts.references.length > 0) return opts.references[0]!;
  if (opts.inReplyTo) return opts.inReplyTo;
  return opts.messageId;
}

/** Map a thread key to the reserved `thread:<hash>` topic used for routing. */
export function topicForThreadKey(threadKey: string): string {
  const hash = createHash('sha256').update(threadKey).digest('hex').slice(0, 16);
  return `${THREAD_TOPIC_PREFIX}${hash}`;
}

/** Strip leading Re:/Fwd:/Fw: prefixes (any number, any case) to a base subject. */
export function baseSubject(subject: string): string {
  return subject.replace(/^\s*((re|fwd?|fw)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
}

/** Build a reply subject: a single `Re: ` prefix on the base subject. */
export function replySubject(subject: string): string {
  const base = baseSubject(subject) || '(no subject)';
  return `Re: ${base}`;
}

/**
 * Build the outbound References chain for a reply: the inbound chain followed by
 * the message we are replying to, as space-joined `<id>` tokens (RFC 5322 form).
 */
export function buildReferencesChain(inboundRefs: string[], inboundMessageId: string): string {
  const ids = [...inboundRefs];
  if (inboundMessageId && !ids.includes(inboundMessageId)) ids.push(inboundMessageId);
  return ids.map((id) => `<${id}>`).join(' ');
}

/**
 * Conservatively strip quoted reply history from a plain-text email body, keeping
 * only the new content the sender typed at the top. Cuts at the first recognized
 * reply boundary (`On … wrote:`, `-----Original Message-----`, `From: …` block,
 * or a run of `>`-quoted lines). Falls back to the full body if stripping would
 * empty it — sessions are long-lived so over-trimming costs context, but a blank
 * message is worse.
 */
export function stripQuotedReply(body: string): string {
  const lines = body.split(/\r?\n/);
  const boundaries = [
    /^\s*On\b.*\bwrote:\s*$/i, // "On Mon, … <addr> wrote:"
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
    /^\s*_{5,}\s*$/, // Outlook divider
    /^\s*>{1,}/, // start of quoted block
    /^\s*From:\s.+/i, // forwarded/quoted header block
    /^\s*Sent from my\b/i, // mobile signature often precedes quotes
  ];

  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (boundaries.some((re) => re.test(lines[i]!))) {
      cut = i;
      break;
    }
  }

  const kept = lines.slice(0, cut).join('\n').trim();
  return kept.length > 0 ? kept : body.trim();
}

/**
 * Choose the inbound body text to hand the agent.
 *
 * For a **threaded reply** (the message has In-Reply-To/References, so it continues
 * an existing conversation) we strip the quoted history: those earlier turns already
 * live in the thread's long-lived session, so re-feeding the quoted chain every
 * message just burns context.
 *
 * For a **new thread** — a first-contact email or a **forward** — we keep the full
 * body. A forward is a fresh compose with no References, and its quoted/forwarded
 * block is the actual content the user wants the agent to read; there is no prior
 * session to dedupe against, so stripping would only lose information.
 */
export function selectInboundBody(text: string, isThreadedReply: boolean): string {
  return isThreadedReply ? stripQuotedReply(text) : text.trim();
}

/**
 * Decide whether verified DKIM results authenticate the sender: at least one
 * signature must verify (`pass`) AND be aligned with the From domain. mailauth
 * computes alignment itself and reports it in `status.aligned` — note its value
 * is the **aligned domain string** (e.g. `"icloud.com"`) when aligned, or a falsy
 * value when not (despite the typings calling it a boolean), so we test it for
 * truthiness rather than `=== true`. Pure: unit-testable without DNS.
 */
export function dkimAuthenticated(
  results: Array<{ result: string; aligned?: boolean | string }>,
): boolean {
  return results.some((r) => r.result === 'pass' && Boolean(r.aligned));
}

/** Two domains are aligned when equal or one is a subdomain of the other. */
function domainsAligned(a: string, b: string): boolean {
  if (!a || !b) return false;
  a = a.toLowerCase();
  b = b.toLowerCase();
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Decide whether inbound mail is authentic enough to trust its From address,
 * from one or more `Authentication-Results` header values added by the receiving
 * server. Pragmatic (not a full DMARC engine):
 *   - dmarc=pass            → trusted (DMARC already enforces From alignment)
 *   - dkim=pass, d= aligned → trusted (the From domain signed it)
 *   - spf=pass, mailfrom aligned → trusted
 * Anything else (including a missing header) is untrusted, defeating a spoofed
 * From on an allowlisted address.
 */
export function isSenderAuthenticated(authResults: string[], fromDomain: string): boolean {
  if (!fromDomain) return false;
  const blob = authResults.join(' ; ').toLowerCase();
  if (!blob) return false;

  if (/\bdmarc=pass\b/.test(blob)) return true;

  // DKIM pass with a signing domain (header.d= / header.i=@) aligned to From.
  for (const m of blob.matchAll(/\bdkim=pass\b[^;]*?\bheader\.(?:d|i)=@?([a-z0-9.-]+)/g)) {
    if (domainsAligned(m[1]!, fromDomain)) return true;
  }

  // SPF pass with an envelope-from (smtp.mailfrom) aligned to From.
  for (const m of blob.matchAll(/\bspf=pass\b[^;]*?\bsmtp\.mailfrom=(?:[^@\s;]*@)?([a-z0-9.-]+)/g)) {
    if (domainsAligned(m[1]!, fromDomain)) return true;
  }

  return false;
}
