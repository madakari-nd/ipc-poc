import type { z } from 'zod';

/** Thrown when configuration is missing or invalid. Lists keys, never values. */
export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * 12-factor config loader (Constitution VI): validates env against a zod schema at startup.
 * Services call this before listening and exit on ConfigError (refuse to start).
 */
export function loadConfig<S extends z.ZodTypeAny>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
    );
  }
  return parsed.data;
}
