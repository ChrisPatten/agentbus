import type { AppConfig } from '../../config/schema.js';
import { channelMatches, type PipelineStage } from '../types.js';
import { processInbound } from '../../http/api.js';
import { renderTemplate } from '../../adapters/prompt-renderer.js';

/**
 * Once a message has been relayed this many times, the relay rule is skipped
 * and the message falls through to the normal (non-relay) pipeline instead —
 * a backstop against a misconfigured relay cycle (A -> B -> A -> ...).
 */
const MAX_RELAY_HOPS = 3;

/**
 * Stage 25 — Channel Relay (E26)
 *
 * Runs after contact-resolve (20), before dedup (30) — early enough to skip
 * wasted downstream work on the original envelope, late enough that
 * ctx.envelope.sender is already canonicalized to contact:<id>.
 *
 * Matches the first relay rule from config.pipeline.relays (same AND-ed
 * sender/channel/topic matching route-resolve uses). On a match, renders
 * target.template over the message body and re-submits the result as a
 * brand-new inbound message on target.channel via processInbound() — the
 * same shared enqueue+pipeline path the HTTP route and platform adapters
 * use — then aborts (returns null) so the *original* envelope never reaches
 * dedup/route-resolve/transcript-log. The relayed message runs the full
 * pipeline from the top, on its own terms, as if it had arrived on the
 * target channel natively.
 *
 * No match, or the hop limit is hit: returns ctx unchanged so the normal
 * pipeline proceeds.
 */
export function createChannelRelay(
  config: AppConfig,
  deps: Parameters<typeof processInbound>[1],
): PipelineStage {
  const relays = config.pipeline.relays;

  // Warn at construction time if a non-last catch-all rule shadows subsequent
  // rules — mirrors the equivalent route-resolve.ts warning.
  for (let i = 0; i < relays.length - 1; i++) {
    const { match } = relays[i]!;
    if (!match.sender && !match.channel && !match.topic) {
      console.warn(
        `[pipeline:channel-relay] Catch-all relay at index ${i} (match: {}) shadows all subsequent rules`,
      );
    }
  }

  return async (ctx) => {
    const e = ctx.envelope;

    for (const rule of relays) {
      const { match } = rule;
      if (match.sender && match.sender !== e.sender) continue;
      if (match.channel && !channelMatches(match.channel, e.channel)) continue;
      if (match.topic && match.topic !== e.topic) continue;

      const hops = typeof e.metadata['relay_hops'] === 'number' ? e.metadata['relay_hops'] : 0;
      if (hops >= MAX_RELAY_HOPS) {
        console.warn(
          `[pipeline:channel-relay] Hop limit (${MAX_RELAY_HOPS}) reached relaying ` +
            `${e.channel} -> ${rule.target.channel} (sender=${e.sender}); skipping relay, ` +
            `message proceeds through the normal pipeline`,
        );
        break;
      }

      const body =
        e.payload.type === 'reaction'
          ? `[reaction:${e.payload.removed ? 'removed' : 'added'} ${e.payload.emoji}]`
          : e.payload.body;
      const renderedBody = renderTemplate(rule.target.template, {
        body,
        sender: e.sender,
        channel: e.channel,
      });

      console.log(
        `[pipeline:channel-relay] ${e.channel} -> ${rule.target.channel} sender=${e.sender}`,
      );

      await processInbound(
        {
          channel: rule.target.channel,
          sender: e.sender,
          payload: { type: 'text', body: renderedBody },
          metadata: {
            relayed_from: { channel: e.channel, id: e.id, timestamp: e.timestamp },
            relay_hops: hops + 1,
          },
        },
        deps,
      );

      return null;
    }

    return ctx;
  };
}
