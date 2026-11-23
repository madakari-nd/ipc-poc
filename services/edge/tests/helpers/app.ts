import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createLogger } from '@ipc/platform';
import { createApps, type AppConfig, type EdgeDeps } from '../../src/app.js';
import { FakeElevateUser, FakeObjectStore, FakeWorkflow, MemoryStore } from './fakes.js';
import type { TestDb } from './mongo.js';

export const SECRET = 'test-service-secret-0123456789abcdef';

export const testConfig = (over: Partial<AppConfig> = {}): AppConfig => ({
  IPC_PROFILE: 'test',
  APP_VERSION: '0.1.0-test',
  TRUST_PROXY: 'loopback',
  SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SERVICE_JWT_SECRET: SECRET,
  DEMO_MODE: true,
  OPENAPI_VALIDATE_RESPONSES: true,
  RATE_LIMIT_USER_PER_MIN: 10_000,
  RATE_LIMIT_LOGIN_PER_MIN: 10_000,
  WEB_IDLE_TIMEOUT_MIN: 30,
  DEVICE_SESSION_DAYS: 7,
  ...over,
});

export interface Harness {
  app: ReturnType<typeof createApps>['publicApp'];
  priv: ReturnType<typeof createApps>['privateApp'];
  apps: ReturnType<typeof createApps>;
  workflow: FakeWorkflow;
  elevate: FakeElevateUser;
  store: FakeObjectStore;
  clock: { now: number };
  login(userId: string, client?: 'web' | 'field'): Promise<Agent>;
}

export interface Agent {
  cookie: string;
  csrf: string;
  body: Record<string, unknown>;
  get(path: string): request.Test;
  write(method: 'post' | 'put' | 'patch' | 'delete', path: string, body?: unknown, headers?: Record<string, string>): request.Test;
}

export function buildHarness(db: TestDb, over: Omit<Partial<EdgeDeps>, 'config'> & { config?: Partial<AppConfig> } = {}): Harness {
  const workflow = new FakeWorkflow();
  const elevate = new FakeElevateUser();
  const store = new FakeObjectStore();
  const clock = { now: Date.now() };
  const apps = createApps({
    models: db.models,
    workflow,
    elevateUser: elevate,
    store,
    logger: createLogger('edge-test', 'silent'),
    rateLimitStore: (p) => new MemoryStore(p),
    readiness: { mongo: async () => true, minio: () => store.ping() },
    now: () => clock.now,
    ...over,
    config: testConfig(over.config),
  });
  const app = apps.publicApp;
  return {
    app,
    priv: apps.privateApp,
    apps,
    workflow: (over.workflow as FakeWorkflow) ?? workflow,
    elevate: (over.elevateUser as FakeElevateUser) ?? elevate,
    store: (over.store as FakeObjectStore) ?? store,
    clock,
    async login(userId, client = 'web') {
      const res = await request(app)
        .post('/ipc/v1/auth/login')
        .send({ identifier: userId, password: 'pw', client, ...(client === 'field' ? { deviceId: randomUUID() } : {}) });
      if (res.status !== 200) throw new Error(`login ${userId} failed: ${res.status} ${JSON.stringify(res.body)}`);
      const cookie = String(res.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
      const csrf = String(res.body.csrfToken);
      return {
        cookie,
        csrf,
        body: res.body as Record<string, unknown>,
        get: (path) => request(app).get(path).set('Cookie', cookie),
        write: (method, path, body, headers = {}) => {
          const t = request(app)[method](path).set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Idempotency-Key', randomUUID());
          for (const [k, v] of Object.entries(headers)) t.set(k, v);
          return body === undefined ? t : t.send(body as object);
        },
      };
    },
  };
}
