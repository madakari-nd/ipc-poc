import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

/** Stable problem codes (mirrors ProblemCode in contracts/openapi.yaml). */
export type ProblemCode =
  | 'SCOPE_DENIED' | 'NOT_OWNER' | 'ROLE_DENIED' | 'VERSION_CONFLICT' | 'IF_MATCH_REQUIRED'
  | 'IDEMPOTENCY_KEY_REQUIRED' | 'IDEMPOTENCY_KEY_REUSED' | 'IDEMPOTENCY_KEY_IN_PROGRESS'
  | 'CHECKLIST_PUBLISHED' | 'CHECKLIST_VERSION_RETIRED' | 'INVALID_TRANSITION' | 'DEPENDENCY_OPEN'
  | 'DECLARATION_REQUIRED' | 'EVIDENCE_RULE_NOT_MET' | 'RATE_LIMITED' | 'ELEVATE_UNAVAILABLE'
  | 'DEMO_MODE_DISABLED' | 'VALIDATION_FAILED' | 'UNAUTHENTICATED' | 'CSRF_INVALID'
  | 'NOT_FOUND' | 'INTERNAL_ERROR' | (string & {});

const TITLES: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict',
  422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** RFC 9457 problem; throw it anywhere in a request and problemHandler renders it. */
export class Problem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ProblemCode,
    public readonly detail?: string,
    public readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail ?? code);
    this.name = 'Problem';
  }
  static badRequest(code: ProblemCode, detail?: string, ext?: Record<string, unknown>) { return new Problem(400, code, detail, ext); }
  static unauthorized(detail = 'Sign in required') { return new Problem(401, 'UNAUTHENTICATED', detail); }
  static forbidden(code: ProblemCode, detail?: string) { return new Problem(403, code, detail); }
  static notFound(detail?: string) { return new Problem(404, 'NOT_FOUND', detail); }
  static conflict(code: ProblemCode, detail?: string, ext?: Record<string, unknown>) { return new Problem(409, code, detail, ext); }
  static unprocessable(code: ProblemCode, detail?: string, ext?: Record<string, unknown>) { return new Problem(422, code, detail, ext); }
  static tooMany(detail = 'Too many requests, slow down') { return new Problem(429, 'RATE_LIMITED', detail); }
  static unavailable(code: ProblemCode = 'ELEVATE_UNAVAILABLE', detail?: string) { return new Problem(503, code, detail); }
}

function render(res: Response, p: Problem) {
  res
    .status(p.status)
    .type('application/problem+json')
    .json({
      type: `https://ipc.example/problems/${String(p.code).toLowerCase().replace(/_/g, '-')}`,
      title: TITLES[p.status] ?? 'Error',
      status: p.status,
      code: p.code,
      ...(p.detail ? { detail: p.detail } : {}),
      correlationId: res.locals.correlationId as string | undefined,
      ...p.extensions,
    });
}

export function notFoundHandler() {
  return (_req: Request, res: Response) => render(res, Problem.notFound('No such route'));
}

/** Express error middleware: Problems as-is, validation errors as 400, everything else 500. */
export function problemHandler(logger?: Logger) {
  return (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof Problem) {
      if (err.status >= 500) logger?.error({ err, code: err.code }, 'request failed');
      return render(res, err);
    }
    const e = err as { status?: number; errors?: unknown; type?: string };
    if (e?.status === 400 || e?.type === 'entity.parse.failed') {
      return render(res, Problem.badRequest('VALIDATION_FAILED', 'Request is not valid', { errors: e.errors }));
    }
    if (e?.status === 413) return render(res, new Problem(413, 'VALIDATION_FAILED', 'Request too large'));
    logger?.error({ err }, 'unhandled error');
    return render(res, new Problem(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'));
  };
}
