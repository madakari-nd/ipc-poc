import client from 'prom-client';
import type { NextFunction, Request, Response } from 'express';

/** One registry per process; default Node metrics + programme metrics (research §5). */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequests = new client.Counter({
  name: 'http_requests_total', help: 'HTTP requests', labelNames: ['route', 'method', 'code'] as const, registers: [registry],
});
export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['route', 'method', 'code'] as const,
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
});
export const elevateCallDuration = new client.Histogram({
  name: 'elevate_call_duration_seconds', help: 'ELEVATE call duration (measured separately from programme time)',
  labelNames: ['service', 'operation', 'outcome'] as const, buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry],
});
export const elevateCircuitState = new client.Gauge({
  name: 'elevate_circuit_state', help: '0 closed, 1 half-open, 2 open', labelNames: ['service'] as const, registers: [registry],
});
export const outboxPending = new client.Gauge({ name: 'outbox_pending', help: 'Unpublished outbox events', registers: [registry] });
export const dlqSize = new client.Gauge({ name: 'dlq_size', help: 'Dead-letter entries', registers: [registry] });
export const escalationSweepRuns = new client.Counter({ name: 'escalation_sweep_runs_total', help: 'Escalation sweeps', registers: [registry] });
export const escalationSweepFailures = new client.Counter({ name: 'escalation_sweep_failures_total', help: 'Failed sweeps', registers: [registry] });
export const deviceStaleQueues = new client.Gauge({ name: 'device_stale_queues', help: 'Devices with items older than 72h', registers: [registry] });

/** Records rate, errors and latency per route template. */
export function httpMetrics() {
  return (req: Request, res: Response, next: NextFunction) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      const route = (req.route?.path as string | undefined) ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      const labels = { route, method: req.method, code: String(res.statusCode) };
      httpRequests.inc(labels);
      end(labels);
    });
    next();
  };
}

export async function metricsHandler(_req: Request, res: Response) {
  res.type(registry.contentType).send(await registry.metrics());
}
