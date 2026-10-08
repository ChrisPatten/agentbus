/**
 * Advisory text (E65): the agent-facing system block and the owner-facing
 * direct message.
 */
import { renderSystemBlock } from '../core/system-block.js';
import type { Advisory } from './types.js';

/** `kind` attribute of the advisory system block. */
export const ADVISORY_BLOCK_KIND = 'advisories';

/**
 * One system block listing `advisories` for the agent to relay. With
 * `systemTurn`, the block says no one sent a message (a critical advisory
 * woke the agent).
 */
export function renderAdvisoryBlock(advisories: readonly Advisory[], opts: { systemTurn?: boolean } = {}): string {
  const lines: string[] = [
    opts.systemTurn
      ? 'AgentBus advisory turn. No one sent a message; the bus started this turn to deliver the advisories below.'
      : 'AgentBus advisories. These come from the bus, not from the person messaging you.',
    'Tell your owner about each one in your own words, including what to do, then call advisory_ack with its id.',
  ];
  advisories.forEach((a, i) => {
    lines.push(
      '',
      `${i + 1}. [${a.severity}] ${a.title}`,
      `   id: ${a.id}`,
      ...a.body.split('\n').map((l) => `   ${l}`),
      `   What to do: ${a.remediation}`,
    );
  });
  return renderSystemBlock(ADVISORY_BLOCK_KIND, lines.join('\n'), { count: String(advisories.length) });
}

/** Plain-text message the bus sends an owner directly, without the agent. */
export function renderDirectMessage(advisory: Advisory): string {
  const agent = advisory.agent_id.replace(/^agent:/, '');
  return [
    `AgentBus advisory (${advisory.severity}) for ${agent}: ${advisory.title}`,
    '',
    advisory.body,
    '',
    `What to do: ${advisory.remediation}`,
  ].join('\n');
}
