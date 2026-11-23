import { Router } from 'express';
import { Problem } from '@ipc/platform';

export type Check = () => Promise<boolean>;

export interface DependencyCheck {
  name: string;
  check: Check;
  affects: string[];
  circuit?: () => 'closed' | 'open' | 'half_open';
}

async function timed(fn: Check, ms: number): Promise<{ ok: boolean; latencyMs: number }> {
  const t = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const ok = await Promise.race([
      fn().catch(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), ms);
      }),
    ]);
    return { ok, latencyMs: Math.round(performance.now() - t) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Edge health in the contract shapes (`Health`, `DependencyReport`): /healthz liveness, /readyz
 * own stores only (Mongo + MinIO), /dependencies reports ELEVATE and workflow without ever failing
 * readiness (Constitution VI, NFR-004).
 */
export function healthRoutes(o: {
  version: string;
  readiness: Record<string, Check>;
  dependencies: DependencyCheck[];
}) {
  let draining = false;
  const r = Router();
  r.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'edge', version: o.version });
  });
  r.get('/readyz', async (_req, res) => {
    const checks: Record<string, 'ok' | 'down'> = {};
    await Promise.all(
      Object.entries(o.readiness).map(async ([k, fn]) => {
        checks[k] = (await timed(fn, 2000)).ok ? 'ok' : 'down';
      }),
    );
    const down = Object.entries(checks).filter(([, v]) => v === 'down').map(([k]) => k);
    if (draining || down.length) {
      throw new Problem(503, 'STORAGE_UNAVAILABLE', draining ? 'Shutting down' : 'Not ready', {
        unavailable: draining ? ['edge'] : down,
      });
    }
    res.json({ status: 'ok', service: 'edge', version: o.version, checks });
  });
  // /dependencies needs a session (x-roles ANY_AUTHENTICATED); the session stage runs before this router.
  r.get('/dependencies', async (_req, res) => {
    const dependencies = await Promise.all(
      o.dependencies.map(async (d) => {
        const { ok, latencyMs } = await timed(d.check, 3000);
        const circuit = d.circuit?.();
        return {
          name: d.name,
          status: ok ? (circuit && circuit !== 'closed' ? 'degraded' : 'up') : 'down',
          ...(circuit ? { circuit } : {}),
          latencyMs,
          ...(ok ? {} : { affects: d.affects }),
        };
      }),
    );
    res.json({ checkedAt: new Date().toISOString(), dependencies });
  });
  return Object.assign(r, {
    setDraining: () => {
      draining = true;
    },
  });
}
