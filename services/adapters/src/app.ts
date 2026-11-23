import express, { type Express } from 'express';
import { correlation, healthRouter, httpMetrics, notFoundHandler, Problem, problemHandler, type Check, type HealthRouter, type Logger } from '@ipc/platform';
import type { ImportService } from './importers/import.service.js';
import { importRoutes } from './routes/imports.routes.js';

export interface AdaptersDeps {
  logger: Logger;
  readiness: Record<string, Check>;
  /** US1 imports: `/internal/imports` (service JWT from the Edge). Absent → 503 naming `missing`. */
  imports?: { service: ImportService; secret: string } | { missing: string[] };
}

/** Adapters run jobs (imports, SMS stand-in, analytics feed); HTTP is health + metrics + private import API. */
export function createApp(d: AdaptersDeps): { app: Express; health: HealthRouter } {
  const app = express();
  app.disable('x-powered-by');
  app.use(correlation());
  app.use(httpMetrics());
  const health = healthRouter({ service: 'adapters', readiness: d.readiness, dependencies: {} });
  app.use(health);
  if (d.imports && 'service' in d.imports) {
    app.use(express.json({ limit: '6mb', strict: true }));
    app.use(importRoutes(d.imports.service, d.imports.secret));
  } else if (d.imports) {
    const missing = d.imports.missing;
    app.use('/internal/imports', () => {
      throw new Problem(503, 'ELEVATE_UNAVAILABLE', `Imports are not configured (${missing.join(', ')})`, { unavailable: ['imports'] });
    });
  }
  app.use(notFoundHandler());
  app.use(problemHandler(d.logger));
  return { app, health };
}
