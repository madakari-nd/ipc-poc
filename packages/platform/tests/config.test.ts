import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig, ConfigError } from '../src/config.js';

const schema = z.object({
  PORT: z.coerce.number().int().min(1),
  IPC_PROFILE: z.enum(['dev', 'test', 'uat', 'prod']),
  SECRET: z.string().min(8),
});

describe('loadConfig (12-factor, refuse to start on bad config)', () => {
  it('parses and coerces valid env', () => {
    const c = loadConfig(schema, { PORT: '8080', IPC_PROFILE: 'uat', SECRET: '12345678' });
    expect(c).toEqual({ PORT: 8080, IPC_PROFILE: 'uat', SECRET: '12345678' });
  });

  it('throws ConfigError listing every bad key without leaking values', () => {
    try {
      loadConfig(schema, { PORT: 'x', IPC_PROFILE: 'staging', SECRET: 'short-secret-value'.slice(0, 3) });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain('PORT');
      expect(msg).toContain('IPC_PROFILE');
      expect(msg).toContain('SECRET');
      expect(msg).not.toContain('sho');
    }
  });
});
