/**
 * Slack channel adapter (E76, S76.0 POC) — outbound only.
 *
 * `send()` POSTs `{slack_user_id, message}` to an n8n webhook, and n8n posts
 * the DM from its Slack bot. AgentBus never talks to Slack directly and never
 * takes an inbound connection, so it works from a laptop behind NAT. Each
 * request carries a fresh HS256 JWT (`Authorization: Bearer`) that n8n's
 * Webhook "JWT Auth" verifies.
 *
 * The recipient is always a configured contact: `contact:<id>` resolves to
 * `contacts.<id>.platforms.slack.user_id`, so an agent can only DM people the
 * operator has listed. Response mapping:
 *   - 2xx with `ok !== false` → delivered (`platformMessageId` = Slack `ts`)
 *   - 400 / 401 / 403 / other 4xx → failed, not retried (bad body or bad secret)
 *   - 429 / 5xx / timeout / network error → retryable via `DeliveryWorker`
 * See docs/SLACK_ADAPTER.md.
 */
import type { MessageEnvelope } from '../types/envelope.js';
import type {
  AdapterCapabilities,
  AdapterInstance,
  DeliveryResult,
  HealthStatus,
} from '../core/registry.js';
import type { AppConfig, SlackAdapterConfig } from '../config/schema.js';
import { signJwt } from './slack-jwt.js';

/**
 * undici's "fetch failed" hides the real reason (DNS, refused connection, TLS
 * trust) in `cause`. Surface its code so a TLS problem such as a replaced CA
 * store (`SSL_CERT_FILE`) reads as UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
 */
function describeFetchError(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  if (!cause) return String(err);
  return `${String(err)} (${[cause.code, cause.message].filter(Boolean).join(': ')})`;
}

export class SlackAdapter implements AdapterInstance {
  readonly id = 'slack';
  readonly name = 'Slack';
  readonly capabilities: AdapterCapabilities = {
    send: true,
    // Slack's own chat.postMessage limit; splitting arrives with S76.5.
    maxMessageLength: 40000,
    channels: ['slack'],
  };

  private lastSuccess: string | undefined;
  private lastError: string | undefined;
  private consecutiveFailures = 0;

  constructor(
    private readonly cfg: SlackAdapterConfig,
    private readonly contacts: AppConfig['contacts'],
  ) {}

  async start(): Promise<void> {
    console.log(`[slack] adapter ready — outbound via n8n webhook ${new URL(this.cfg.webhook_url).host}`);
  }

  async stop(): Promise<void> {}

  async health(): Promise<HealthStatus> {
    return {
      status: this.consecutiveFailures >= 3 ? 'degraded' : 'healthy',
      ...(this.lastSuccess ? { lastActivity: this.lastSuccess } : {}),
      details: {
        consecutive_failures: this.consecutiveFailures,
        ...(this.lastError ? { last_error: this.lastError } : {}),
      },
    };
  }

  async send(envelope: MessageEnvelope): Promise<DeliveryResult> {
    if (envelope.payload.type === 'reaction') {
      return { success: false, retryable: false, error: 'slack channel does not support reactions yet' };
    }

    const contactId = envelope.recipient.startsWith('contact:')
      ? envelope.recipient.slice('contact:'.length)
      : envelope.recipient;
    const userId = this.contacts[contactId]?.platforms.slack?.user_id;
    if (!userId) {
      return {
        success: false,
        retryable: false,
        error: `contact "${contactId}" has no platforms.slack.user_id`,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(
      { iss: 'agentbus', iat: now, exp: now + this.cfg.jwt_ttl_seconds, jti: envelope.id },
      this.cfg.jwt_secret,
    );

    let res: Response;
    try {
      res = await fetch(this.cfg.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ slack_user_id: userId, message: envelope.payload.body }),
        signal: AbortSignal.timeout(this.cfg.request_timeout_ms),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError'
        ? `timed out after ${this.cfg.request_timeout_ms}ms`
        : describeFetchError(err);
      return this.failed(`n8n webhook unreachable: ${reason}`, true);
    }

    const text = await res.text().catch(() => '');
    let body: { ok?: boolean; ts?: unknown; error?: unknown } = {};
    try {
      body = text ? (JSON.parse(text) as typeof body) : {};
    } catch {
      // n8n answered with non-JSON; the status code still decides the outcome.
    }

    if (res.ok && body.ok !== false) {
      this.consecutiveFailures = 0;
      this.lastError = undefined;
      this.lastSuccess = new Date().toISOString();
      return { success: true, platformMessageId: typeof body.ts === 'string' ? body.ts : envelope.id };
    }

    const detail = typeof body.error === 'string' ? body.error : text.slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      console.error(
        `[slack] n8n rejected the JWT (HTTP ${res.status}) — check adapters.slack.jwt_secret matches the n8n JWT credential`,
      );
    }
    const retryable = res.status === 429 || res.status >= 500;
    return this.failed(`n8n webhook HTTP ${res.status}${detail ? `: ${detail}` : ''}`, retryable);
  }

  private failed(error: string, retryable: boolean): DeliveryResult {
    this.consecutiveFailures++;
    this.lastError = error;
    console.warn(`[slack] send failed (${retryable ? 'retryable' : 'not retried'}): ${error}`);
    return { success: false, retryable, error };
  }
}
