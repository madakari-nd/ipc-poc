import {
  ConsecutiveBreaker, SamplingBreaker, ExponentialBackoff, TimeoutStrategy, circuitBreaker,
  handleAll, retry, timeout, wrap, BrokenCircuitError, TaskCancelledError, CircuitState,
  type IPolicy,
} from 'cockatiel';

export class DependencyUnavailableError extends Error {
  constructor(public readonly dependency: string, cause?: unknown) {
    super(`${dependency} unavailable`);
    this.name = 'DependencyUnavailableError';
    this.cause = cause;
  }
}

export interface ResilienceOptions {
  timeoutMs: number;
  retries: number;
  baseDelayMs: number;
  /** failure ratio that opens the breaker (sampling) */
  breakerThreshold: number;
  breakerMinimumRps?: number;
  breakerHalfOpenAfterMs: number;
}

export const DEFAULT_RESILIENCE: ResilienceOptions = {
  timeoutMs: 5000,
  retries: 3,
  baseDelayMs: 200,
  breakerThreshold: 0.5,
  breakerMinimumRps: 1,
  breakerHalfOpenAfterMs: 30_000,
};

export interface Resilience {
  /** Runs fn under timeout (+ retries only when idempotent) + circuit breaker. */
  execute<T>(fn: (signal: AbortSignal) => Promise<T>, opts: { idempotent: boolean }): Promise<T>;
  state(): 'closed' | 'open' | 'half-open' | 'isolated';
}

/**
 * Per-dependency resilience (research T6): every ELEVATE/storage call goes through this.
 * ELEVATE hangs on unknown routes, so a timeout is mandatory on every call.
 */
export function createResilience(dependency: string, o: ResilienceOptions = DEFAULT_RESILIENCE): Resilience {
  const breaker = circuitBreaker(handleAll, {
    halfOpenAfter: o.breakerHalfOpenAfterMs,
    breaker:
      o.breakerMinimumRps !== undefined
        ? new SamplingBreaker({ threshold: o.breakerThreshold, duration: 10_000, minimumRps: o.breakerMinimumRps })
        : new ConsecutiveBreaker(5),
  });
  const tmo = timeout(o.timeoutMs, TimeoutStrategy.Aggressive);
  const retrier = retry(handleAll, {
    maxAttempts: o.retries,
    backoff: new ExponentialBackoff({ initialDelay: o.baseDelayMs, maxDelay: o.baseDelayMs * 20 }),
  });
  const idem: IPolicy = wrap(breaker, retrier, tmo);
  const once: IPolicy = wrap(breaker, tmo);

  return {
    async execute(fn, { idempotent }) {
      try {
        return await (idempotent ? idem : once).execute(({ signal }) => fn(signal));
      } catch (err) {
        if (err instanceof BrokenCircuitError || err instanceof TaskCancelledError) {
          throw new DependencyUnavailableError(dependency, err);
        }
        throw new DependencyUnavailableError(dependency, err);
      }
    },
    state() {
      switch (breaker.state) {
        case CircuitState.Open: return 'open';
        case CircuitState.HalfOpen: return 'half-open';
        case CircuitState.Isolated: return 'isolated';
        default: return 'closed';
      }
    },
  };
}
