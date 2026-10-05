import { describe, expect, it } from 'vitest';
import { HeadlessLimiter } from './headless-limiter.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('HeadlessLimiter', () => {
  it('runs four users and one system, leaving a fifth user queued', async () => {
    const limiter = new HeadlessLimiter(5, 1);
    const users = await Promise.all(Array.from({ length: 4 }, () => limiter.acquire('user')));
    let fifthStarted = false;
    const fifth = limiter.acquire('user').then((release) => { fifthStarted = true; return release; });
    const system = await limiter.acquire('system');
    expect(limiter.snapshot()).toMatchObject({ running_user: 4, running_system: 1, waiting: 1 });
    system();
    await tick();
    expect(fifthStarted).toBe(false);
    users[0]!();
    const fifthRelease = await fifth;
    expect(fifthStarted).toBe(true);
    fifthRelease();
    users.slice(1).forEach((release) => release());
    expect(limiter.snapshot()).toMatchObject({ running_user: 0, running_system: 0, waiting: 0 });
  });

  it('starts the oldest eligible waiter when a user ahead of a system is blocked', async () => {
    const limiter = new HeadlessLimiter(5, 1);
    const users = await Promise.all(Array.from({ length: 4 }, () => limiter.acquire('user')));
    const fifth = limiter.acquire('user');
    const systemRelease = await limiter.acquire('system');
    let sixthStarted = false;
    const sixth = limiter.acquire('system').then((release) => { sixthStarted = true; return release; });
    systemRelease();
    const releaseSixth = await sixth;
    expect(sixthStarted).toBe(true);
    expect(limiter.snapshot().waiting).toBe(1);
    users[0]!();
    const releaseFifth = await fifth;
    releaseFifth();
    releaseSixth();
    users.slice(1).forEach((release) => release());
  });

  it('removes an aborted waiter and never consumes a slot', async () => {
    const limiter = new HeadlessLimiter(2, 1);
    const first = await limiter.acquire('user');
    const controller = new AbortController();
    const waiting = limiter.acquire('user', controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow('turn cancelled');
    expect(limiter.snapshot()).toMatchObject({ running_user: 1, waiting: 0 });
    first();
  });

  it('rejects invalid reserved capacity', () => {
    expect(() => new HeadlessLimiter(5, 5)).toThrow();
    expect(() => new HeadlessLimiter(0, 0)).toThrow();
  });
});
