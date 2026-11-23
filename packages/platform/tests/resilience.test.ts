import { describe, expect, it, vi } from 'vitest';
import { createResilience, DependencyUnavailableError } from '../src/resilience.js';

describe('resilience policies (timeout, retry with jitter, circuit breaker)', () => {
  it('retries idempotent calls and then succeeds', async () => {
    const r = createResilience('svc', { timeoutMs: 200, retries: 3, baseDelayMs: 1, breakerThreshold: 0.99, breakerHalfOpenAfterMs: 1000 });
    let n = 0;
    const out = await r.execute(async () => { n += 1; if (n < 3) throw new Error('flaky'); return 'ok'; }, { idempotent: true });
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('does not retry non-idempotent calls', async () => {
    const r = createResilience('svc', { timeoutMs: 200, retries: 3, baseDelayMs: 1, breakerThreshold: 0.99, breakerHalfOpenAfterMs: 1000 });
    const fn = vi.fn(async () => { throw new Error('fail'); });
    await expect(r.execute(fn, { idempotent: false })).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging call (ELEVATE hangs on unknown routes)', async () => {
    const r = createResilience('svc', { timeoutMs: 30, retries: 0, baseDelayMs: 1, breakerThreshold: 0.99, breakerHalfOpenAfterMs: 1000 });
    const started = Date.now();
    await expect(r.execute((signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))), { idempotent: true })).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('opens the circuit after repeated failures and fails fast', async () => {
    const r = createResilience('svc', { timeoutMs: 50, retries: 0, baseDelayMs: 1, breakerThreshold: 0.5, breakerMinimumRps: 0.5, breakerHalfOpenAfterMs: 10_000 });
    const fail = async () => { throw new Error('down'); };
    for (let i = 0; i < 6; i++) await r.execute(fail, { idempotent: false }).catch(() => undefined);
    expect(r.state()).toBe('open');
    const fn = vi.fn(async () => 'x');
    await expect(r.execute(fn, { idempotent: true })).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(fn).not.toHaveBeenCalled();
  });
});
