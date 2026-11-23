import type { NextFunction, Request, Response } from 'express';
import { Problem } from '@ipc/platform';

const STRONG_ETAG = /^"(\d{1,9})"$/;

/** Parses `If-Match: "<v>"` (strong ETag); throws 400 IF_MATCH_REQUIRED / VALIDATION_FAILED. */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined || header.trim() === '') {
    throw Problem.badRequest('IF_MATCH_REQUIRED', 'If-Match header with the version you edited is required');
  }
  const m = STRONG_ETAG.exec(header.trim());
  if (!m) throw Problem.badRequest('VALIDATION_FAILED', 'If-Match must be a strong ETag like "7"');
  return Number(m[1]);
}

/** If-Match stage (T042): operations that declare `If-Match` must send it; exposes `req.ifMatch`. */
export function ifMatchMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.operation?.ifMatch) req.ifMatch = parseIfMatch(req.header('if-match'));
    next();
  };
}

/** 409 VERSION_CONFLICT with the current resource, so the client can show the differences view (FR-016). */
export function assertVersion(expected: number | undefined, current: { v: number; body: unknown }): void {
  if (expected === undefined) throw Problem.badRequest('IF_MATCH_REQUIRED', 'If-Match header is required');
  if (expected !== current.v) {
    throw Problem.conflict('VERSION_CONFLICT', 'Someone changed this item since you opened it', {
      currentVersion: current.v,
      current: current.body,
    });
  }
}

export const etag = (v: number) => `"${v}"`;
