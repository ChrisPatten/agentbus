import type { PipelineStage } from '../types.js';

/**
 * Stage 40 — Slash Command Detect
 *
 * If payload.body starts with '/', parses command name and args and sets
 * ctx.isSlashCommand + ctx.slashCommand. Rewrites envelope.payload to the
 * slash_command variant. Never aborts — commands continue for transcript logging.
 */
export const slashCommandDetect: PipelineStage = async (ctx) => {
  const body = ctx.envelope.payload.body;
  if (!body.startsWith('/')) return ctx;

  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return ctx;

  const commandName = match[1]!;
  const argsRaw = (match[2] ?? '').trim();
  const args = argsRaw ? argsRaw.split(/\s+/) : [];

  ctx.isSlashCommand = true;
  ctx.slashCommand = { name: commandName, args, argsRaw };
  ctx.envelope.payload = {
    type: 'slash_command',
    body,
    command: commandName,
    args_raw: argsRaw,
  };

  return ctx;
};
