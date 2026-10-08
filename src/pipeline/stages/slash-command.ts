import type { PipelineStage } from '../types.js';

/**
 * Stage 40 — Slash Command Detect
 *
 * If payload.body starts with '/', parses command name and args and sets
 * ctx.isSlashCommand + ctx.slashCommand. Rewrites envelope.payload to the
 * slash_command variant. `//name` parses as `name` with forceProvider set.
 * Never aborts — commands continue for transcript logging.
 */
export const slashCommandDetect: PipelineStage = async (ctx) => {
  if (ctx.envelope.payload.type !== 'text') return ctx;
  const body = ctx.envelope.payload.body;
  if (!body.startsWith('/')) return ctx;

  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return ctx;

  // Strip @botname suffix (Telegram sends "/status@MyBot" in group chats)
  let commandName = match[1]!.split('@')[0]!;
  // "//name" forces forwarding to the provider (E71). A bare "//" or
  // "// text" is not a command at all.
  const forceProvider = commandName.startsWith('/');
  if (forceProvider) commandName = commandName.slice(1);
  if (!commandName) return ctx;
  const argsRaw = (match[2] ?? '').trim();
  const args = argsRaw ? argsRaw.split(/\s+/) : [];

  ctx.isSlashCommand = true;
  ctx.slashCommand = { name: commandName, args, argsRaw, ...(forceProvider ? { forceProvider } : {}) };
  ctx.envelope.payload = {
    type: 'slash_command',
    body,
    command: commandName,
    args_raw: argsRaw,
  };

  return ctx;
};
