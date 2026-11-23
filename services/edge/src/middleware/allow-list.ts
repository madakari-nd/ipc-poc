import type { NextFunction, Request, Response } from 'express';
import { Problem } from '@ipc/platform';
import type { OperationIndex } from '../openapi/operations.js';

/**
 * Route allow-list (FR-034): only contract operations served by this listener exist. Anything else
 * (the ELEVATE scheduler, `/internal` on the public port, ELEVATE admin or file routes) is 404
 * before any session, scope or proxy work.
 */
export function routeAllowList(index: OperationIndex, passThrough: string[] = []) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (passThrough.includes(req.path)) return next();
    const op = index.match(req.method, req.path);
    if (!op) throw Problem.notFound('No such route');
    req.operation = op;
    next();
  };
}
