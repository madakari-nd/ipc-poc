import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

interface RequestContext {
  correlationId: string;
  traceparent: string;
}

const store = new AsyncLocalStorage<RequestContext>();

/** Correlation id of the current request (W3C trace id), for logs and outbound calls. */
export function currentCorrelationId(): string | undefined {
  return store.getStore()?.correlationId;
}

/** traceparent to forward on outbound calls so the trace continues (NFR-003). */
export function currentTraceparent(): string | undefined {
  return store.getStore()?.traceparent;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** Reads or creates a W3C traceparent; exposes the trace id as correlationId. */
export function correlation() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('traceparent');
    const m = incoming ? TRACEPARENT.exec(incoming) : null;
    const traceId = m?.[1] ?? randomUUID().replace(/-/g, '');
    const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
    const ctx = { correlationId: traceId, traceparent: `00-${traceId}-${spanId}-01` };
    res.locals.correlationId = traceId;
    res.setHeader('X-Correlation-Id', traceId);
    store.run(ctx, () => next());
  };
}

/** Run a function with a given correlation context (consumers, jobs). */
export function withCorrelation<T>(correlationId: string, fn: () => T): T {
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  return store.run({ correlationId, traceparent: `00-${correlationId}-${spanId}-01` }, fn);
}
