import type { NextFunction, Request, Response } from 'express';
import { DependencyUnavailableError, Problem, type Logger } from '@ipc/platform';

interface ValidatorError {
  status?: number;
  type?: string;
  errors?: { path?: string; message?: string }[];
}

const missingHeader = (e: ValidatorError, header: string) =>
  (e.errors ?? []).some((x) => x.path === `/headers/${header}` && /required/.test(x.message ?? ''));

/**
 * Maps everything that is not already a Problem into the contract's problem codes before the
 * platform problemHandler renders it (validator errors, body-parser errors, dependency failures).
 */
export function toProblem(logger: Logger) {
  return (err: unknown, req: Request, _res: Response, next: NextFunction) => {
    if (err instanceof Problem) return next(err);
    if (err instanceof DependencyUnavailableError) {
      return next(new Problem(503, 'STORAGE_UNAVAILABLE', `${err.dependency} is unavailable`, { unavailable: [err.dependency] }));
    }
    const e = (err ?? {}) as ValidatorError;
    if (e.type === 'entity.too.large' || e.status === 413) {
      return next(new Problem(413, 'VALIDATION_FAILED', 'Request body is too large'));
    }
    if (e.type === 'entity.parse.failed') return next(Problem.badRequest('VALIDATION_FAILED', 'Body is not valid JSON'));
    if (e.status === 404 || e.status === 405) return next(Problem.notFound('No such route'));
    if (e.status === 400 || e.status === 415) {
      if (missingHeader(e, 'idempotency-key')) {
        return next(Problem.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required on writes'));
      }
      if (missingHeader(e, 'if-match')) {
        return next(Problem.badRequest('IF_MATCH_REQUIRED', 'If-Match header with the version you edited is required'));
      }
      const errors = (e.errors ?? []).slice(0, 50).map((x) => ({
        path: String(x.path ?? '').slice(0, 200),
        message: String(x.message ?? '').slice(0, 300),
      }));
      return next(Problem.badRequest('VALIDATION_FAILED', 'Request is not valid', { errors }));
    }
    logger.error({ err, path: req.path }, 'unhandled error');
    return next(new Problem(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'));
  };
}
