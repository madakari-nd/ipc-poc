import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { healthRouter } from '../src/health.js';

describe('health endpoints (NFR-004)', () => {
  it('readyz checks only own stores; dependencies reports ELEVATE without failing readiness', async () => {
    const app = express();
    app.use(
      healthRouter({
        readiness: { mongo: async () => true },
        dependencies: { 'elevate.project': async () => false, 'elevate.user': async () => true },
      }),
    );
    expect((await request(app).get('/healthz')).status).toBe(200);
    const ready = await request(app).get('/readyz');
    expect(ready.status).toBe(200);
    const deps = await request(app).get('/dependencies');
    expect(deps.status).toBe(200);
    expect(deps.body.dependencies).toEqual({ 'elevate.project': 'down', 'elevate.user': 'up' });
  });

  it('readyz is 503 when an own store is down', async () => {
    const app = express();
    app.use(healthRouter({ readiness: { mongo: async () => false }, dependencies: {} }));
    const r = await request(app).get('/readyz');
    expect(r.status).toBe(503);
    expect(r.body.checks.mongo).toBe('down');
  });

  it('readyz is 503 while draining', async () => {
    const app = express();
    const h = healthRouter({ readiness: {}, dependencies: {} });
    app.use(h);
    h.setDraining();
    expect((await request(app).get('/readyz')).status).toBe(503);
  });
});
