import type { NextFunction, Request, Response } from 'express';
import { Problem, type Logger } from '@ipc/platform';
import type { OperationInfo } from '../openapi/operations.js';
import type { Auditor } from './audit.js';
import type { ScopeService } from './scope.service.js';

/**
 * Fields a client may never use to steer scope, role, profile or targeting (FR-028, V3).
 * They are removed unless the operation's contract declares them (e.g. a STATE_ADMIN creating a
 * scope assignment legitimately sends `role` and `scope`; those are then validated and checked).
 */
export const SCOPE_FIELDS = new Set([
  'scope',
  'role',
  'roles',
  'activeRole',
  'profile',
  'targeting',
  'userRoleAndProfileInformation',
  'orgId',
  'organisationId',
  'organizationId',
  'organization_id',
  'organization_ids',
  'tenantId',
  'tenant_code',
  'districtCode',
  'facilityId',
  'facilityIds',
  'wardIds',
  'userId',
  'uploadedBy',
  'createdBy',
]);

/** Never legitimate anywhere in the contract, so stripped at every depth. */
const DEEP_FIELDS = new Set(['targeting', 'userRoleAndProfileInformation']);

function stripDeep(node: unknown, removed: string[], path: string, depth = 0): void {
  if (depth > 8 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((n, i) => stripDeep(n, removed, `${path}[${i}]`, depth + 1));
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (DEEP_FIELDS.has(k)) {
      delete obj[k];
      removed.push(`${path}.${k}`);
    } else stripDeep(obj[k], removed, `${path}.${k}`, depth + 1);
  }
}

/** Removes client-sent scope fields from body and query. Returns the removed field paths. */
export function stripClientScope(
  req: { body?: unknown; query?: Record<string, unknown> },
  op: Pick<OperationInfo, 'bodyProps' | 'queryParams'> | undefined,
): string[] {
  const removed: string[] = [];
  const declaredBody = op?.bodyProps ?? new Set<string>();
  const declaredQuery = op?.queryParams ?? new Set<string>();
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    const body = req.body as Record<string, unknown>;
    for (const k of Object.keys(body)) {
      if (SCOPE_FIELDS.has(k) && !declaredBody.has(k)) {
        delete body[k];
        removed.push(`body.${k}`);
      }
    }
  }
  stripDeep(req.body, removed, 'body');
  if (req.query) {
    // Express 5 recomputes req.query from the URL on every read, so the stripped copy is pinned.
    const query = { ...req.query };
    let changed = false;
    for (const k of Object.keys(query)) {
      if (SCOPE_FIELDS.has(k) && !declaredQuery.has(k)) {
        delete query[k];
        removed.push(`query.${k}`);
        changed = true;
      }
    }
    if (changed) Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true, enumerable: true });
  }
  return removed;
}

/**
 * Scope stage (T039): strips client scope fields BEFORE schema validation (so stripping never trips
 * the unknown-field rule), resolves the server-derived scope into `req.scope`, and refuses roles
 * not in the operation's `x-roles` with 403 ROLE_DENIED (deny by default).
 */
export function scopeMiddleware(scopes: ScopeService, audit: Auditor, logger: Logger) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const removed = stripClientScope(req, req.operation);
    if (removed.length) {
      req.strippedFields = removed;
      logger.info({ fields: removed, op: req.operation?.operationId }, 'client scope fields ignored');
    }
    if (!req.session) return next();
    req.scope = await scopes.resolve(req.session.userId, req.session.activeRole);
    const roles = req.operation?.roles ?? [];
    const allowed =
      roles.includes('PUBLIC') ||
      roles.includes('ANY_AUTHENTICATED') ||
      (req.scope.activeRole !== null && roles.includes(req.scope.activeRole));
    if (!allowed) {
      await audit.denial(req, 'ROLE_DENIED');
      throw Problem.forbidden('ROLE_DENIED', 'Your role cannot do this.');
    }
    next();
  };
}
