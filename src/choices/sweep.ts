/**
 * S74.4 — expiry sweep for choice prompts (E74).
 *
 * Marks every `open` prompt past its `expires_at` as `expired`, then asks the
 * owning adapter (`finalizeChoicePrompt`) to clear the keyboard of every
 * expired prompt that still has a live message ref. Runs on bus-core's
 * existing maintenance interval and once shortly after startup, so keyboards
 * left behind across a restart are cleared too.
 */
import type { AdapterRegistry } from '../core/registry.js';
import type { ChoiceStore } from './store.js';
import type { ChoicePrompt } from './types.js';

export interface SweepChoicesDeps {
  registry: AdapterRegistry;
  store: ChoiceStore;
}

export interface SweepChoicesResult {
  expired: number;
  keyboardsCleared: number;
}

export async function sweepChoices(
  deps: SweepChoicesDeps,
  nowIso: string = new Date().toISOString(),
): Promise<SweepChoicesResult> {
  const expired = deps.store.expireDue(nowIso);
  let keyboardsCleared = 0;
  for (const prompt of deps.store.listNeedingKeyboardCleanup()) {
    if (await clearOne(deps, prompt)) keyboardsCleared++;
  }
  return { expired: expired.length, keyboardsCleared };
}

async function clearOne(deps: SweepChoicesDeps, prompt: ChoicePrompt): Promise<boolean> {
  const adapter = deps.registry.lookupPrimaryByChannel(prompt.channel);
  if (!adapter?.finalizeChoicePrompt) {
    console.error(
      `[choices] sweep: no adapter with finalizeChoicePrompt for channel "${prompt.channel}" ` +
        `(prompt ${prompt.id}) — leaving the message ref set for a future retry`,
    );
    return false;
  }
  try {
    await adapter.finalizeChoicePrompt(prompt);
    deps.store.clearMessageRef(prompt.id);
    return true;
  } catch (err) {
    console.error(`[choices] sweep: finalizeChoicePrompt failed for ${prompt.id}: ${String(err)}`);
    return false;
  }
}
