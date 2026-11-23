import { z } from 'zod';
import type { Dispatcher } from 'undici';
import { ElevateHttp, type ElevateHttpOptions } from './http.js';
import { UserClient } from './user.js';
import { EntityClient } from './entity.js';
import { SamikshaClient } from './samiksha.js';
import { ProjectClient } from './project.js';
import { MentoringClient } from './mentoring.js';
import { SchedulerClient } from './scheduler.js';
import { NotificationClient } from './notification.js';
import { createKafka, ElevateProducer } from './kafka.js';

export * from './http.js';
export * from './user.js';
export * from './entity.js';
export * from './samiksha.js';
export * from './project.js';
export * from './mentoring.js';
export * from './scheduler.js';
export * from './notification.js';
export * from './kafka.js';
export * from './env.js';

/** ELEVATE settings read from `.env.<profile>` (names as in infra/compose/.env.example). */
export const ElevateConfigSchema = z.object({
  ELEVATE_USER_URL: z.string().url(),
  ELEVATE_ENTITY_URL: z.string().url(),
  ELEVATE_SAMIKSHA_URL: z.string().url(),
  ELEVATE_PROJECT_URL: z.string().url(),
  ELEVATE_MENTORING_URL: z.string().url(),
  ELEVATE_SCHEDULER_URL: z.string().url(),
  ELEVATE_KAFKA_BROKERS: z.string().min(1),
  ELEVATE_OBSERVATION_TOPIC: z.string().default('elevate_observations_dev'),
  ELEVATE_PROJECT_TOPIC: z.string().default('sl-improvement-project-submission-dev'),
  ELEVATE_NOTIFICATION_TOPIC: z.string().default('dev.notifications'),
  ELEVATE_INTERNAL_ACCESS_TOKEN: z.string().min(1),
  ELEVATE_ADMIN_TOKEN_ENTITY: z.string().optional(),
  ELEVATE_ADMIN_TOKEN_SAMIKSHA: z.string().optional(),
  ELEVATE_ADMIN_TOKEN_PROJECT: z.string().optional(),
  ELEVATE_ADMIN_TOKEN_MENTORING: z.string().optional(),
  ELEVATE_TENANT_CODE: z.string().default('default'),
  ELEVATE_ORIGIN: z.string().default('http://localhost'),
});
export type ElevateConfig = z.infer<typeof ElevateConfigSchema>;

export interface ElevateClients {
  user: UserClient;
  entity: EntityClient;
  samiksha: SamikshaClient;
  project: ProjectClient;
  mentoring: MentoringClient;
  scheduler: SchedulerClient;
  notification: NotificationClient;
  producer: ElevateProducer;
  close(): Promise<void>;
}

/** Wires one client per ELEVATE service from config. */
export function createElevateClients(
  cfg: ElevateConfig, opts: { clientId?: string; dispatcher?: Dispatcher } = {},
): ElevateClients {
  const common: Partial<ElevateHttpOptions> = {
    internalAccessToken: cfg.ELEVATE_INTERNAL_ACCESS_TOKEN,
    tenantCode: cfg.ELEVATE_TENANT_CODE,
    origin: cfg.ELEVATE_ORIGIN,
    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
  };
  const http = (service: ElevateHttpOptions['service'], baseUrl: string, adminToken?: string) =>
    new ElevateHttp({ ...common, service, baseUrl, ...(adminToken ? { adminToken } : {}) });
  const user = new UserClient(http('user', cfg.ELEVATE_USER_URL));
  const kafka = createKafka({ brokers: cfg.ELEVATE_KAFKA_BROKERS.split(','), clientId: opts.clientId ?? 'ipc-elevate-client' });
  const producer = new ElevateProducer(kafka);
  return {
    user,
    entity: new EntityClient(http('entity', cfg.ELEVATE_ENTITY_URL, cfg.ELEVATE_ADMIN_TOKEN_ENTITY)),
    samiksha: new SamikshaClient(http('samiksha', cfg.ELEVATE_SAMIKSHA_URL, cfg.ELEVATE_ADMIN_TOKEN_SAMIKSHA)),
    project: new ProjectClient(http('project', cfg.ELEVATE_PROJECT_URL, cfg.ELEVATE_ADMIN_TOKEN_PROJECT)),
    mentoring: new MentoringClient(http('mentoring', cfg.ELEVATE_MENTORING_URL, cfg.ELEVATE_ADMIN_TOKEN_MENTORING), user),
    scheduler: new SchedulerClient(http('scheduler', cfg.ELEVATE_SCHEDULER_URL)),
    notification: new NotificationClient(producer, cfg.ELEVATE_NOTIFICATION_TOPIC),
    producer,
    close: () => producer.disconnect(),
  };
}
