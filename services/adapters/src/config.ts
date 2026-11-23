import { z } from 'zod';
import { loadConfig } from '@ipc/platform';

export const configSchema = z.object({
  IPC_PROFILE: z.enum(['dev', 'test', 'uat', 'prod']),
  PORT: z.coerce.number().int().default(8080),
  MONGO_URL: z.string().min(1),
  ELEVATE_KAFKA_BROKERS: z.string().min(1),
  IPC_TOPIC_SUFFIX: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),
  // ---- imports (US1 T069/T070). Optional so the other adapter jobs start without them; without
  // them createImport answers 503 naming the missing settings.
  SERVICE_JWT_SECRET: z.string().min(32).optional(),
  WORKFLOW_URL: z.string().url().default('http://workflow:8080'),
  ELEVATE_USER_URL: z.string().url().optional(),
  ELEVATE_ENTITY_URL: z.string().url().optional(),
  ELEVATE_INTERNAL_ACCESS_TOKEN: z.string().min(1).optional(),
  /** entity-management ADMIN_ACCESS_TOKEN (E15): entity writes carry the admin header set. */
  ELEVATE_ADMIN_TOKEN_ENTITY: z.string().min(1).optional(),
  ELEVATE_TENANT_CODE: z.string().min(1).default('default'),
  ELEVATE_ORIGIN: z.string().url().default('http://localhost'),
  ELEVATE_ADMIN_EMAIL: z.string().min(1).optional(),
  ELEVATE_ADMIN_PASSWORD: z.string().min(1).optional(),
  ELEVATE_ORG_ADMIN_EMAIL: z.string().min(1).optional(),
  ELEVATE_ORG_ADMIN_PASSWORD: z.string().min(1).optional(),
  /** First password of accounts created by the HR import (DEMO_USER_PASSWORD when unset). */
  IPC_INITIAL_PASSWORD: z.string().min(8).optional(),
  DEMO_USER_PASSWORD: z.string().min(8).optional(),
});
export type AdaptersConfig = z.infer<typeof configSchema>;
export const readConfig = (env: Record<string, string | undefined> = process.env) => loadConfig(configSchema, env);

/** Settings the importers need; `missing` lists absent keys (never values). */
export function importSettings(c: AdaptersConfig) {
  const need = {
    SERVICE_JWT_SECRET: c.SERVICE_JWT_SECRET, ELEVATE_USER_URL: c.ELEVATE_USER_URL, ELEVATE_ENTITY_URL: c.ELEVATE_ENTITY_URL,
    ELEVATE_INTERNAL_ACCESS_TOKEN: c.ELEVATE_INTERNAL_ACCESS_TOKEN, ELEVATE_ADMIN_TOKEN_ENTITY: c.ELEVATE_ADMIN_TOKEN_ENTITY, ELEVATE_ADMIN_EMAIL: c.ELEVATE_ADMIN_EMAIL,
    ELEVATE_ADMIN_PASSWORD: c.ELEVATE_ADMIN_PASSWORD, ELEVATE_ORG_ADMIN_EMAIL: c.ELEVATE_ORG_ADMIN_EMAIL,
    ELEVATE_ORG_ADMIN_PASSWORD: c.ELEVATE_ORG_ADMIN_PASSWORD, IPC_INITIAL_PASSWORD: c.IPC_INITIAL_PASSWORD ?? c.DEMO_USER_PASSWORD,
  };
  const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
  return { missing, values: need as { [K in keyof typeof need]: string } };
}
