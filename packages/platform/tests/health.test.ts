import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { healthRouter } from '../src/health.js';

describe('health endpoints (NFR-004, contract Health / DependencyReport)', () => {
  it('readyz checks only own stores; dependencies reports ELEVATE without failing readiness', async () => {
    const app = express();
    app.use(
      healthRouter({
        service: 'workflow',
        version: '1.2.3',
        readiness: { mongo: async () => true },
        dependencies: { 'elevate-project': async () => false, 'elevate-user': async () => true },
        circuit: (n) => (n === 'elevate-project' ? 'open' : 'closed'),
      }),
    );
    const live = await request(app).get('/healthz');
    expect(live.body).toEqual({ status: 'ok', service: 'workflow', version: '1.2.3' });
    const ready = await request(app).get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ok', checks: { mongo: 'ok' } });
    const deps = await request(app).get('/dependencies');
    expect(deps.status).toBe(200);
    expect(typeof deps.body.checkedAt).toBe('string');
    const byName = Object.fromEntries(deps.body.dependencies.map((d: { name: string }) => [d.name, d]));
    expect(byName['elevate-project']).toMatchObject({ status: 'down', circuit: 'open' });
    expect(byName['elevate-user']).toMatchObject({ status: 'up', circuit: 'closed' });
  });

  it('readyz is 503 when an own store is down', async () => {
    const app = express();
    app.use(healthRouter({ service: 'edge', readiness: { mongo: async () => false }, dependencies: {} }));
    const r = await request(app).get('/readyz');
    expect(r.status).toBe(503);
    expect(r.body.checks.mongo).toBe('down');
  });

  it('readyz is 503 while draining', async () => {
    const app = express();
    const h = healthRouter({ service: 'edge', readiness: {}, dependencies: {} });
    app.use(h);
    h.setDraining();
    expect((await request(app).get('/readyz')).status).toBe(503);
  });
});
