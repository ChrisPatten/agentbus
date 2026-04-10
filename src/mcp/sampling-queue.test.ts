import { describe, it, expect, vi } from 'vitest';
import { createSamplingQueue } from './sampling-queue.js';

/** Returns a deferred promise — resolve() is called externally to control timing. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSamplingQueue', () => {
  it('calls sendCreateMessage with the enqueued text', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = createSamplingQueue(send);

    q.enqueue('hello');
    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 0));

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('hello');
  });

  it('delivers 3 messages in FIFO order with no overlap', async () => {
    const calls: string[] = [];
    const barriers: Array<() => void> = [];

    const send = vi.fn().mockImplementation((text: string) => {
      calls.push(text);
      return new Promise<void>((resolve) => {
        barriers.push(resolve);
      });
    });

    const q = createSamplingQueue(send);

    q.enqueue('A');
    q.enqueue('B');
    q.enqueue('C');

    // Only first call should have fired
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['A']);

    // Release A → B fires
    barriers[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['A', 'B']);

    // Release B → C fires
    barriers[1]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(3);
    expect(calls).toEqual(['A', 'B', 'C']);

    // Release C → done
    barriers[2]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(q.inFlight).toBe(false);
    expect(q.pending).toBe(0);
  });

  it('continues draining after an error on one call', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('client rejected'))
      .mockResolvedValueOnce(undefined);

    const q = createSamplingQueue(send);
    q.enqueue('fail');
    q.enqueue('succeed');

    await new Promise((r) => setTimeout(r, 10));

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports pending and inFlight accurately', async () => {
    const d = deferred();
    const send = vi.fn().mockReturnValue(d.promise);
    const q = createSamplingQueue(send);

    expect(q.pending).toBe(0);
    expect(q.inFlight).toBe(false);

    q.enqueue('X');
    await new Promise((r) => setTimeout(r, 0));

    expect(q.inFlight).toBe(true);
    expect(q.pending).toBe(0);

    q.enqueue('Y');
    expect(q.pending).toBe(1);

    d.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(q.inFlight).toBe(false);
    expect(q.pending).toBe(0);
  });
});
