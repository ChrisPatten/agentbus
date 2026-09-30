import type { MessageEnvelope } from '../types/envelope.js';
import type { AdapterInstance, AdapterCapabilities, DeliveryResult, HealthStatus } from '../core/registry.js';
import type { CommandManifest } from '../commands/registry.js';
import type Database from 'better-sqlite3';
import type { HeadlessActivityEvent, HeadlessCapacitySnapshot } from './cc-headless.js';
import { ensureOutboundAppSession, validateAppDestination } from '../app/outbound.js';
import { boundAppReply } from '../app/binding.js';
import { logOutboundTranscript, renderOutboundBody } from '../pipeline/outbound-transcript.js';
import { computeConversationId } from '../pipeline/conversation-id.js';

/** Local, durable delivery target. Socket presence never gates DeliveryWorker. */
export type AppActivityEvent = HeadlessActivityEvent & { typing?: boolean; tool_lines?: string[] };

export class AppAdapter implements AdapterInstance {
  readonly id = 'app';
  readonly name = 'Mac App';
  readonly capabilities: AdapterCapabilities = {
    send: true, typing: true, toolStatus: true, registerCommands: true, activityState: true, channels: ['app'],
  };
  private commands: CommandManifest[] = [];
  private lastActivity?: string;
  private activityListener: (event: AppActivityEvent) => void = () => {};
  private readonly toolLines = new Map<string, string[]>();

  constructor(
    private readonly db: Database.Database,
    private readonly agentFor: (contactId: string) => string | null,
    private readonly capacitySnapshots: () => HeadlessCapacitySnapshot[] = () => [],
  ) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async health(): Promise<HealthStatus> {
    return { status: 'healthy', ...(this.lastActivity ? { lastActivity: this.lastActivity } : {}) };
  }
  async send(envelope: MessageEnvelope): Promise<DeliveryResult> {
    return this.persist(envelope, false);
  }
  /** Direct bus command responses may close their source session before sending. */
  async sendCommandResponse(envelope: MessageEnvelope): Promise<DeliveryResult> {
    return this.persist(envelope, true);
  }
  private async persist(envelope: MessageEnvelope, allowClosed: boolean): Promise<DeliveryResult> {
    const contactId = envelope.recipient.replace(/^contact:/, '');
    const agentId = this.agentFor(contactId);
    if (!agentId) return { success: false, error: 'app channel is not routed for this contact' };
    try {
      const bound = boundAppReply(this.db, envelope.reply_to, contactId, agentId, allowClosed);
      if (!bound) {
        const target = validateAppDestination(this.db, contactId, agentId, envelope.topic || 'general');
        if (!target.ok) return { success: false, error: target.error };
      }
      // The app may be closed for days. Persist its only client-visible copy
      // before telling DeliveryWorker that delivery succeeded. The transcript
      // trigger writes the replay event in this same transaction.
      this.db.transaction(() => {
        const { conversationId, sessionId } = bound ?? ensureOutboundAppSession(
          this.db, contactId, agentId, envelope.topic || 'general',
        );
        logOutboundTranscript(this.db, {
          messageId: envelope.id,
          conversationId,
          sessionId,
          channel: 'app',
          contactId,
          body: renderOutboundBody(envelope.payload),
          metadata: envelope.metadata,
        });
      })();
      this.lastActivity = new Date().toISOString();
      this.finishActivity(contactId, agentId, envelope.topic || 'general', bound?.conversationId);
      return { success: true, platformMessageId: envelope.id };
    } catch (error) {
      return { success: false, error: `Could not persist app message: ${String(error)}`, retryable: true };
    }
  }
  async registerCommands(commands: CommandManifest[]): Promise<void> { this.commands = commands; }
  commandManifest(): CommandManifest[] { return this.commands; }
  setActivityListener(listener: (event: AppActivityEvent) => void): void { this.activityListener = listener; }
  publishActivity(event: HeadlessActivityEvent): void {
    const key = `${event.agent_id}:${event.conversation_id}`;
    if (event.state === 'idle') this.toolLines.delete(key);
    const lines = this.toolLines.get(key);
    this.activityListener(lines?.length ? { ...event, tool_lines: [...lines] } : event);
  }
  private finishActivity(contactId: string, agentId: string, topic: string, boundConversationId?: string): void {
    const conversationId = boundConversationId ?? computeConversationId(contactId, 'app', topic);
    const key = `${agentId}:${conversationId}`;
    if (!this.toolLines.has(key)) return;
    this.toolLines.delete(key);
    const capacity = this.capacity(agentId);
    this.activityListener({ agent_id: agentId, conversation_id: conversationId,
      state: 'idle', turn_class: 'user', ...capacity });
  }
  private capacity(agentId: string): Omit<HeadlessActivityEvent, 'agent_id' | 'conversation_id' | 'session_id' | 'state' | 'turn_class'> {
    const snapshot = this.capacitySnapshots().find((item) => item.agent_id === agentId);
    return snapshot
      ? { running_user: snapshot.running_user, running_system: snapshot.running_system,
          waiting: snapshot.waiting, limit: snapshot.limit, reserved_system_slots: snapshot.reserved_system_slots }
      : { running_user: 0, running_system: 0, waiting: 0, limit: 0, reserved_system_slots: 0 };
  }
  private ephemeral(contactId: string, channel: string, topic: string, toolLine?: string, boundConversationId?: string): void {
    const bare = contactId.replace(/^contact:/, '');
    const agentId = this.agentFor(bare);
    if (!agentId) return;
    const conversationId = boundConversationId ?? computeConversationId(bare, channel, topic);
    const row = this.db.prepare(`SELECT id FROM sessions WHERE conversation_id = ? AND contact_id = ? AND agent_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`).get(conversationId, bare, agentId) as {id:string}|undefined;
    if (!row) return;
    const key = `${agentId}:${conversationId}`;
    if (toolLine) {
      const lines = this.toolLines.get(key) ?? [];
      lines.push(toolLine);
      if (lines.length > 40) lines.splice(0, lines.length - 40);
      this.toolLines.set(key, lines);
    }
    const lines = this.toolLines.get(key);
    const event = { agent_id: agentId, conversation_id: conversationId, session_id: row.id,
      state: 'running' as const, turn_class: 'user' as const,
      ...this.capacity(agentId),
      ...(lines?.length ? { tool_lines: [...lines] } : { typing: true }) };
    this.activityListener(event);
  }
  startTyping(contactId: string, channel = 'app', topic = 'general', conversationId?: string): void { this.ephemeral(contactId, channel, topic, undefined, conversationId); }
  reportToolCall(contactId: string, text: string, channel = 'app', topic = 'general', _placeholder?: boolean, conversationId?: string): void { this.ephemeral(contactId, channel, topic, text, conversationId); }
}
