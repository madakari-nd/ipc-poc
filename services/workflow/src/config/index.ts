import { z } from 'zod';
import { loadConfig } from '@ipc/platform';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().min(1)).min(1));

/**
 * Workflow configuration (12-factor, Constitution VI). Invalid or missing values stop the service
 * before it listens. Secrets are never logged: ConfigError lists keys only.
 */
export const workflowConfigSchema = z
  .object({
    IPC_PROFILE: z.enum(['dev', 'test', 'uat', 'prod']),
    DEMO_MODE: bool,
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /** Bind address. Compose attaches workflow to the private networks only (no published port). */
    HOST: z.string().min(1).default('0.0.0.0'),
    MONGO_URL: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// URL'),
    MONGO_DB: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/).optional(),
    SERVICE_JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    SERVICE_JWT_ISSUERS: list('ipc-edge,ipc-adapters'),
    SERVICE_JWT_AUDIENCE: z.string().min(1).default('ipc-workflow'),
    /** Edge private listener (edgeInternalEvidenceDQ for the US8 data-quality list). */
    EDGE_INTERNAL_URL: z.string().url().default('http://edge:8081'),
    SCHEDULER_SHARED_SECRET: z.string().min(16),
    ELEVATE_KAFKA_BROKERS: list('').describe('comma-separated host:port list'),
    /** ELEVATE organisation of this profile: consumed events from any other org are ignored (E16). */
    ELEVATE_ORG_ID: z.string().min(1).max(64),
    IPC_CONSUMER_GROUP: z.string().min(1).optional(),
    KAFKA_CLIENT_ID: z.string().min(1).default('ipc-workflow'),
    OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(1000).default(20),
    // ---- ELEVATE admin calls (US1: checklist publish E5/E19, cycle plan solutions FR-018a). Optional:
    // without them those operations answer 503 ELEVATE_UNAVAILABLE naming the missing setting.
    ELEVATE_USER_URL: z.string().url().optional(),
    ELEVATE_ENTITY_URL: z.string().url().optional(),
    ELEVATE_SAMIKSHA_URL: z.string().url().optional(),
    ELEVATE_PROJECT_URL: z.string().url().optional(),
    ELEVATE_INTERNAL_ACCESS_TOKEN: z.string().min(1).optional(),
    /** entity-management ADMIN_ACCESS_TOKEN (E15): entity writes carry the admin header set. */
    ELEVATE_ADMIN_TOKEN_ENTITY: z.string().min(1).optional(),
    ELEVATE_TENANT_CODE: z.string().min(1).default('default'),
    ELEVATE_ORIGIN: z.string().url().default('http://localhost'),
    /** ELEVATE organisation code used for solution copies (E18, e.g. default_code). */
    ELEVATE_ORG_CODE: z.string().min(1).max(64).default('default_code'),
    ELEVATE_ORG_ADMIN_EMAIL: z.string().min(1).optional(),
    ELEVATE_ORG_ADMIN_PASSWORD: z.string().min(1).optional(),
    /** Code prefix of this profile's ELEVATE records (E16). */
    IPC_CODE_PREFIX: z.string().max(16).default(''),
    /** Samiksha solution (_id) checklist v1 is copied from when a draft has no solution yet. */
    IPC_CHECKLIST_TEMPLATE_SOLUTION_ID: z.string().regex(/^[a-f0-9]{24}$/).optional(),
    /** Reusable project template (externalId) copied into each new cycle's plan solution. */
    IPC_PLAN_TEMPLATE_EXTERNAL_ID: z.string().min(1).max(128).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .refine((c) => !(c.DEMO_MODE && c.IPC_PROFILE === 'prod'), {
    path: ['DEMO_MODE'],
    message: 'DEMO_MODE must be false in prod (FR-038)',
  })
  .transform((c) => ({
    ...c,
    MONGO_DB: c.MONGO_DB ?? `ipc_${c.IPC_PROFILE}`,
    IPC_CONSUMER_GROUP: c.IPC_CONSUMER_GROUP ?? `ipc-workflow-${c.IPC_PROFILE}`,
  }));

export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;

export function loadWorkflowConfig(env: Record<string, string | undefined> = process.env): WorkflowConfig {
  return loadConfig(workflowConfigSchema, env);
}
