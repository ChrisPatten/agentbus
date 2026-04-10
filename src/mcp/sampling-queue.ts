/**
 * Sampling queue — FIFO serialization for `sampling/createMessage` calls.
 *
 * Ensures only one `createMessage` is in-flight at a time. New messages
 * enqueued while a call is pending are held and delivered sequentially
 * after the current call completes (success or error).
 */

export interface SamplingQueue {
  enqueue(text: string): void;
  readonly pending: number;
  readonly inFlight: boolean;
}

/**
 * Create a serialized sampling queue.
 *
 * @param sendCreateMessage - async function that fires a single createMessage call.
 *   On error, the error is logged and draining continues with the next item.
 */
export function createSamplingQueue(
  sendCreateMessage: (text: string) => Promise<void>,
): SamplingQueue {
  const queue: string[] = [];
  let inFlight = false;

  async function drain(): Promise<void> {
    if (inFlight || queue.length === 0) return;

    inFlight = true;
    const text = queue.shift()!;

    console.error(`[agentbus] createMessage in flight, ${queue.length} message(s) queued`);

    try {
      await sendCreateMessage(text);
    } catch (err) {
      console.error(`[agentbus] createMessage error: ${String(err)}`);
    } finally {
      inFlight = false;
    }

    // Process next item if any arrived while this one was in-flight
    void drain();
  }

  return {
    enqueue(text: string): void {
      queue.push(text);
      console.error(
        `[agentbus] sampling queue: enqueued (depth=${queue.length}, inFlight=${inFlight})`,
      );
      void drain();
    },
    get pending(): number {
      return queue.length;
    },
    get inFlight(): boolean {
      return inFlight;
    },
  };
}
