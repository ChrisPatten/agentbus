import type { PipelineContext, PipelineStageDefinition } from './types.js';

/**
 * PipelineEngine — runs registered middleware stages in priority (slot) order.
 *
 * Stages are registered via `use()` and executed in ascending slot order.
 * A stage returning `null` aborts the pipeline; remaining stages are skipped.
 * An error in a critical stage (default) also aborts; a non-critical stage
 * error is logged and the pipeline continues with the context unchanged.
 *
 * On abort, `ctx.abortReason` is set on the ORIGINAL context passed to
 * `process()` so the caller can inspect the reason even though null is
 * returned.
 */
export class PipelineEngine {
  private stages: PipelineStageDefinition[] = [];

  /** Register a stage. Maintains sorted order by slot. */
  use(def: PipelineStageDefinition): void {
    this.stages.push(def);
    this.stages.sort((a, b) => a.slot - b.slot);
  }

  /** Run all registered stages in slot order. Returns null if any stage aborts.
   *  On abort, `ctx.abortReason` is set so the caller can read it from the
   *  original context reference. */
  async process(ctx: PipelineContext): Promise<PipelineContext | null> {
    let current: PipelineContext = ctx;
    for (const { name, stage, critical } of this.stages) {
      let result: PipelineContext | null;
      try {
        result = await stage(current);
      } catch (err) {
        const isCritical = critical !== false; // default true
        console.error(`[pipeline] Stage "${name}" threw: ${String(err)}`);
        if (isCritical) {
          ctx.abortReason = `Stage "${name}" error: ${String(err)}`;
          return null;
        }
        // Non-critical: log and continue with unchanged context
        console.log(`[pipeline] Skipping non-critical stage "${name}" after error`);
        continue;
      }

      if (result === null) {
        ctx.abortReason = `Aborted at stage "${name}"`;
        console.log(`[pipeline] ${ctx.abortReason}`);
        return null;
      }
      current = result;
    }
    return current;
  }
}
