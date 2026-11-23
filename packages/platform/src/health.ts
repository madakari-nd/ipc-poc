import { Router, type Router as ExpressRouter } from 'express';
import { metricsHandler } from './metrics.js';

export type Check = () => Promise<boolean>;

export interface HealthOptions {
  service: 'edge' | 'workflow' | 'adapters';
  version?: string;
  /** Own stores and broker only (Constitution VI v1.1.1, NFR-004). */
  readiness: Record<string, Check>;
  /** ELEVATE and other dependencies: reported, never fail readiness. Keys use contract names, e.g. "elevate-project". */
  dependencies: Record<string, Check>;
  /** Optional circuit state per dependency name. */
  circuit?: (name: string) => 'closed' | 'open' | 'half_open' | undefined;
}

interface Result { status: 'up' | 'down'; latencyMs: number }

async function run(checks: Record<string, Check>, timeoutMs: number): Promise<Record<string, Result>> {
  const out: Record<string, Result> = {};
  await Promise.all(
    Object.entries(checks).map(async ([k, fn]) => {
      const t0 = performance.now();
      let ok = false;
      try {
        ok = await Promise.race([fn(), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
      } catch {
        ok = false;
      }
      out[k] = { status: ok ? 'up' : 'down', latencyMs: Math.round(performance.now() - t0) };
    }),
  );
  return out;
}

export type HealthRouter = ExpressRouter & { setDraining(): void };

/**
 * Contract shapes: /healthz and /readyz return `Health`; /dependencies returns `DependencyReport`.
 * Readiness never includes ELEVATE, so an ELEVATE outage never takes the service out of rotation.
 */
export function healthRouter(opts: HealthOptions): HealthRouter {
  let draining = false;
  const version = opts.version ?? process.env.IPC_VERSION ?? '0.1.0';
  const r = Router() as HealthRouter;
  r.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: opts.service, version });
  });
  r.get('/readyz', async (_req, res) => {
    const results = await run(opts.readiness, 2000);
    const checks = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.status === 'up' ? 'ok' : 'down']));
    const ok = !draining && Object.values(checks).every((v) => v === 'ok');
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'down', service: opts.service, version, checks });
  });
  r.get('/dependencies', async (_req, res) => {
    const results = await run(opts.dependencies, 3000);
    res.json({
      checkedAt: new Date().toISOString(),
      dependencies: Object.entries(results).map(([name, v]) => {
        const circuit = opts.circuit?.(name);
        return { name, status: v.status, latencyMs: v.latencyMs, ...(circuit ? { circuit } : {}) };
      }),
    });
  });
  r.get('/metrics', metricsHandler);
  r.setDraining = () => {
    draining = true;
  };
  return r;
}
