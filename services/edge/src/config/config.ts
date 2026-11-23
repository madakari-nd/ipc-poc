import { z } from 'zod';
import { loadConfig } from '@ipc/platform';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const key32 = z
  .string()
  .min(1)
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64');

/** Edge configuration (12-factor, Constitution VI): validated at startup, refuses to start when invalid. */
export const edgeConfigSchema = z.object({
  IPC_PROFILE: z.enum(['dev', 'test', 'uat', 'prod']),
  APP_VERSION: z.string().max(32).default('0.1.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  PRIVATE_PORT: z.coerce.number().int().positive().default(8081),
  /** Address the private listener binds to (the `private` network interface in compose). */
  PRIVATE_BIND_HOST: z.string().default('0.0.0.0'),
  TRUST_PROXY: z.string().default('loopback, uniquelocal'),
  MONGO_URL: z.string().url(),
  SESSION_ENCRYPTION_KEY: key32,
  SERVICE_JWT_SECRET: z.string().min(32),
  WORKFLOW_URL: z.string().url().default('http://workflow:8080'),
  ELEVATE_USER_URL: z.string().url(),
  ELEVATE_SAMIKSHA_URL: z.string().url(),
  ELEVATE_MENTORING_URL: z.string().url().optional(),
  ELEVATE_ORIGIN: z.string().url().default('http://localhost'),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  EVIDENCE_BUCKET: z.string().min(3),
  DEMO_MODE: bool,
  OPENAPI_VALIDATE_RESPONSES: bool,
  RATE_LIMIT_USER_PER_MIN: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_LOGIN_PER_MIN: z.coerce.number().int().positive().default(20),
  WEB_IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(30),
  DEVICE_SESSION_DAYS: z.coerce.number().int().positive().default(7),
});

export type EdgeConfig = z.infer<typeof edgeConfigSchema>;

/** Loads config; MinIO root credentials are accepted as the S3 key pair when no S3_* pair is set. */
export function loadEdgeConfig(env: Record<string, string | undefined> = process.env): EdgeConfig {
  return loadConfig(edgeConfigSchema, {
    ...env,
    S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID ?? env.MINIO_ROOT_USER,
    S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY ?? env.MINIO_ROOT_PASSWORD,
  });
}

/** Demo mode is only honoured in dev, test and uat (FR-038). */
export function demoModeEnabled(c: Pick<EdgeConfig, 'DEMO_MODE' | 'IPC_PROFILE'>): boolean {
  return c.DEMO_MODE && c.IPC_PROFILE !== 'prod';
}

export const edgeDbName = (profile: string) => `edge_${profile}`;
