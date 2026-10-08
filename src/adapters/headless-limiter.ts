/** One cc-headless instance's process capacity. A lease lasts until child exit. */
export type TurnClass = 'user' | 'system';

interface Waiter {
  turnClass: TurnClass;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

export class HeadlessLimiter {
  private runningUser = 0;
  private runningSystem = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly limit: number, readonly reservedSystemSlots: number) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(reservedSystemSlots) ||
        reservedSystemSlots < 0 || reservedSystemSlots >= limit) {
      throw new Error('invalid headless concurrency limits');
    }
  }

  snapshot(): { running_user: number; running_system: number; waiting: number; limit: number; reserved_system_slots: number } {
    return {
      running_user: this.runningUser,
      running_system: this.runningSystem,
      waiting: this.waiters.length,
      limit: this.limit,
      reserved_system_slots: this.reservedSystemSlots,
    };
  }

  private eligible(turnClass: TurnClass): boolean {
    const total = this.runningUser + this.runningSystem;
    return total < this.limit &&
      (turnClass === 'system' || this.runningUser < this.limit - this.reservedSystemSlots);
  }

  private lease(turnClass: TurnClass): () => void {
    if (turnClass === 'system') this.runningSystem++;
    else this.runningUser++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (turnClass === 'system') this.runningSystem--;
      else this.runningUser--;
      this.drain();
    };
  }

  acquire(turnClass: TurnClass, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('turn cancelled'));
    // An older eligible waiter always wins, including when capacity changes
    // between releases and requests.
    this.drain();
    if (this.waiters.length === 0 && this.eligible(turnClass)) {
      return Promise.resolve(this.lease(turnClass));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        turnClass, resolve, reject, signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal?.removeEventListener('abort', waiter.onAbort);
          reject(new Error('turn cancelled'));
          this.drain();
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    while (true) {
      const index = this.waiters.findIndex((waiter) => this.eligible(waiter.turnClass));
      if (index < 0) break;
      const [waiter] = this.waiters.splice(index, 1);
      waiter!.signal?.removeEventListener('abort', waiter!.onAbort);
      waiter!.resolve(this.lease(waiter!.turnClass));
    }
  }
}
