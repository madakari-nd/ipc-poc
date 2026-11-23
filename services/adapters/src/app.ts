import express, { type Express } from 'express';
import { correlation, healthRouter, httpMetrics, notFoundHandler, problemHandler, type Check, type HealthRouter, type Logger } from '@ipc/platform';

export interface AdaptersDeps {
  logger: Logger;
  readiness: Record<string, Check>;
}

/** Adapters run jobs (imports, SMS stand-in, analytics feed); HTTP is health + metrics only. */
export function createApp(d: AdaptersDeps): { app: Express; health: HealthRouter } {
  const app = express();
  app.disable('x-powered-by');
  app.use(correlation());
  app.use(httpMetrics());
  const health = healthRouter({ service: 'adapters', readiness: d.readiness, dependencies: {} });
  app.use(health);
  app.use(notFoundHandler());
  app.use(problemHandler(d.logger));
  return { app, health };
}
