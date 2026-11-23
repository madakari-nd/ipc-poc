import { z } from 'zod';
import { loadConfig } from '@ipc/platform';

export const configSchema = z.object({
  IPC_PROFILE: z.enum(['dev', 'test', 'uat', 'prod']),
  PORT: z.coerce.number().int().default(8080),
  MONGO_URL: z.string().min(1),
  ELEVATE_KAFKA_BROKERS: z.string().min(1),
  IPC_TOPIC_SUFFIX: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),
});
export type AdaptersConfig = z.infer<typeof configSchema>;
export const readConfig = (env: Record<string, string | undefined> = process.env) => loadConfig(configSchema, env);
