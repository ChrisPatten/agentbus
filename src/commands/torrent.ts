/**
 * `/torrent` — download a magnet link to iCloud Books via torrent_to_books.sh.
 *
 * Factored into its own module (rather than living inline in index.ts, where
 * it was originally registered) so the no-arg prompt-and-capture flow and the
 * completion notification (E36) can be exercised in a unit test without
 * pulling in index.ts's top-level startup side effects (config load, DB open,
 * HTTP listen).
 */
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { CommandDefinition } from './registry.js';
import type { CommandRegistry } from './registry.js';
import type { AdapterRegistry } from '../core/registry.js';
import { sendCommandResponse } from '../http/api.js';
import { resolveConversationForOutbound } from '../pipeline/outbound-transcript.js';

export interface TorrentCommandDeps {
  commandRegistry: CommandRegistry;
  db: Database.Database;
  registry: AdapterRegistry;
  /** Injectable for tests; defaults to node:child_process.spawn */
  spawnFn?: typeof spawn;
  /** Injectable for tests; defaults to the real torrent_to_books.sh path */
  scriptPath?: string;
}

export function createTorrentCommand(deps: TorrentCommandDeps): CommandDefinition {
  const spawnFn = deps.spawnFn ?? spawn;
  const script =
    deps.scriptPath ??
    join(process.env['HOME'] ?? '/Users/chrispatten', 'workspace/peggy-claude-code/scripts/torrent_to_books.sh');

  return {
    name: 'torrent',
    description: 'Download a magnet link to iCloud Books',
    usage: '/torrent <magnet-link>',
    scope: 'bus',
    handler: async (args, ctx) => {
      const magnet = args[0];
      if (!magnet || !magnet.startsWith('magnet:')) {
        // No arg: ask for the magnet link and capture the next message from
        // this sender instead of erroring (E36).
        deps.commandRegistry.registerFollowUp(
          ctx.channel,
          ctx.sender,
          'torrent',
          (body) => body.trim().startsWith('magnet:'),
          10 * 60 * 1000,
        );
        return { body: "What's the magnet link? 🧲" };
      }

      const child = spawnFn('/bin/bash', [script, magnet], {
        detached: true,
        stdio: 'ignore',
      });

      // Report completion back to the sender once the (possibly long-running)
      // download finishes — attached before unref() for readability; unref()
      // only affects whether the child alone keeps the event loop alive, it
      // does not stop already-registered listeners from firing, and bus-core
      // has plenty else keeping it alive regardless (E36).
      const { channel, sender, envelope } = ctx;
      const contactId = sender.startsWith('contact:') ? sender.slice('contact:'.length) : sender;
      child.on('exit', (code) => {
        void (async () => {
          try {
            const { conversationId, sessionId } = resolveConversationForOutbound(deps.db, contactId, channel);
            const body =
              code === 0
                ? '📚 Torrent download complete — check iCloud Books!'
                : `⚠️ Torrent download failed (exit code ${code}) — check logs/torrents/ for details`;
            await sendCommandResponse(
              { db: deps.db, registry: deps.registry },
              { envelope, sessionId, conversationId },
              'torrent',
              body,
              { torrent_notification: true },
            );
          } catch (err) {
            console.warn(`[torrent] Failed to send completion notification: ${String(err)}`);
          }
        })();
      });

      child.unref();
      return { body: `Download started. File will appear in iCloud Books when complete.` };
    },
  };
}
