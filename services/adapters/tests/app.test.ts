import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@ipc/platform';
import { createApp } from '../src/app.js';
import { configSchema } from '../src/config.js';

describe('adapters scaffold', () => {
  it('serves contract-shaped health and refuses bad config', async () => {
    const { app } = createApp({ logger: createLogger('t', 'silent'), readiness: { mongo: async () => true } });
    expect((await request(app).get('/healthz')).body).toMatchObject({ status: 'ok', service: 'adapters' });
    expect((await request(app).get('/readyz')).status).toBe(200);
    expect(configSchema.safeParse({ IPC_PROFILE: 'staging' }).success).toBe(false);
  });
});
