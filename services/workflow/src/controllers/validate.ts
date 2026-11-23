import type { z } from 'zod';
import { Problem } from '@ipc/platform';

/** Boundary validation (Constitution VI): unknown fields rejected, field errors in the problem body. */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw Problem.badRequest('VALIDATION_FAILED', 'Request is not valid', {
      errors: r.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.') || '(root)', message: i.message.slice(0, 300) })),
    });
  }
  return r.data;
}
