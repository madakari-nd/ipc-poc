import { describe, expect, it } from 'vitest';
import { ConfigError } from '@ipc/platform';
import { loadWorkflowConfig } from '../src/config/index.js';

const base = {
  IPC_PROFILE: 'uat',
  DEMO_MODE: 'true',
  MONGO_URL: 'mongodb://mongo:27017/?replicaSet=rs0',
  SERVICE_JWT_SECRET: 'k'.repeat(32),
  SCHEDULER_SHARED_SECRET: 's'.repeat(16),
  ELEVATE_KAFKA_BROKERS: 'kafka:29092, kafka2:29092',
  ELEVATE_ORG_ID: '7',
};

describe('workflow config (refuses to start on invalid config)', () => {
  it('loads with defaults', () => {
    const c = loadWorkflowConfig(base);
    expect(c).toMatchObject({
      IPC_PROFILE: 'uat', DEMO_MODE: true, PORT: 8080, MONGO_DB: 'ipc_uat', IPC_CONSUMER_GROUP: 'ipc-workflow-uat',
      ELEVATE_KAFKA_BROKERS: ['kafka:29092', 'kafka2:29092'], SERVICE_JWT_ISSUERS: ['ipc-edge', 'ipc-adapters'], SERVICE_JWT_AUDIENCE: 'ipc-workflow',
    });
  });

  it.each([
    ['missing secret', { SERVICE_JWT_SECRET: undefined }],
    ['short secret', { SERVICE_JWT_SECRET: 'short' }],
    ['bad profile', { IPC_PROFILE: 'staging' }],
    ['no brokers', { ELEVATE_KAFKA_BROKERS: '' }],
    ['no org id', { ELEVATE_ORG_ID: undefined }],
    ['bad mongo url', { MONGO_URL: 'http://x' }],
    ['demo mode in prod', { IPC_PROFILE: 'prod', DEMO_MODE: 'true' }],
  ])('refuses %s', (_n, over) => {
    expect(() => loadWorkflowConfig({ ...base, ...over })).toThrow(ConfigError);
  });

  it('never echoes secret values in the error', () => {
    try {
      loadWorkflowConfig({ ...base, SERVICE_JWT_SECRET: 'tiny-secret-value' });
    } catch (e) {
      expect(String(e)).not.toContain('tiny-secret-value');
    }
  });
});
