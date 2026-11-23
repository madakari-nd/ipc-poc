import type { NextFunction, Request, Response } from 'express';
import { Problem } from '@ipc/platform';
import type { WorkflowClient } from '../workflow/workflow.client.js';
import type { Auditor } from './audit.js';
import type { Actor, CallerScope, ResourceKind, ScopeAssignment, ScopedResource } from './types.js';
import type { WardDirectory } from './ward-directory.js';

export type Need = 'read' | 'owner';
export type Resolved = ScopedResource & { doc?: unknown };
export type ResourceResolver = (id: string, actor: Actor) => Promise<Resolved | null>;

const roleAssignments = (scope: CallerScope): ScopeAssignment[] =>
  scope.assignments.filter((a) => a.role === scope.activeRole);

export const isOwner = (scope: CallerScope, r: ScopedResource) => (r.ownerUserIds ?? []).includes(scope.userId);

function assignmentCovers(a: ScopeAssignment, scope: CallerScope, r: ScopedResource): boolean {
  if (a.role === 'MENTOR') return !!r.facilityId && scope.mentorFacilityIds.includes(r.facilityId);
  const s = a.scope;
  switch (s.level) {
    case 'state':
      return true;
    case 'district':
      return !!r.districtCode && s.districtCode === r.districtCode;
    case 'facility':
      return !!r.facilityId && (s.facilityId === r.facilityId || (s.facilityIds ?? []).includes(r.facilityId));
    case 'wards':
      return !!r.wardId && (s.wardIds ?? []).includes(r.wardId);
    case 'own_tasks':
      return (!!r.wardId && (s.wardIds ?? []).includes(r.wardId)) || isOwner(scope, r);
    default:
      return false;
  }
}

/** Is the resource inside the caller's server-derived scope (active role's assignments only)? */
export function inScope(scope: CallerScope, r: ScopedResource): boolean {
  return roleAssignments(scope).some((a) => assignmentCovers(a, scope, r));
}

/**
 * Decision per the contract 403 policy:
 * - unknown id or outside scope → SCOPE_DENIED (existence is not disclosed)
 * - in scope but the operation needs the owner/assignee and the caller is not → NOT_OWNER
 * - `own_tasks` callers only ever see their own items, so a read of someone else's is NOT_OWNER.
 */
export function decide(scope: CallerScope, r: ScopedResource | null, need: Need): 'ALLOW' | 'SCOPE_DENIED' | 'NOT_OWNER' {
  if (!r || !inScope(scope, r)) return 'SCOPE_DENIED';
  if (need === 'owner' && !isOwner(scope, r)) return 'NOT_OWNER';
  const ownTasksOnly = roleAssignments(scope).every((a) => a.scope.level === 'own_tasks' && a.role !== 'MENTOR');
  if (ownTasksOnly && !isOwner(scope, r)) return 'NOT_OWNER';
  return 'ALLOW';
}

/** Ownership guard (T040): checks every resource id on reads and writes; every denial goes to the ledger. */
export class OwnershipGuard {
  constructor(
    private readonly resolvers: Partial<Record<ResourceKind, ResourceResolver>>,
    private readonly audit: Auditor,
  ) {}

  async check(req: Request, kind: ResourceKind, id: string, need: Need): Promise<Resolved> {
    const scope = req.scope;
    if (!scope) throw Problem.unauthorized();
    const actor: Actor = { userId: scope.userId, role: scope.activeRole ?? 'SYSTEM' };
    const resolver = this.resolvers[kind];
    const resource = resolver ? await resolver(id, actor) : null;
    const verdict = decide(scope, resource, need);
    if (verdict !== 'ALLOW') {
      await this.audit.denial(req, verdict, { kind, id });
      throw Problem.forbidden(
        verdict,
        verdict === 'SCOPE_DENIED' ? 'This item is outside your area.' : 'Only the person this item belongs to can do this.',
      );
    }
    return resource!;
  }

  /** Express middleware: resolves `req.params[param]` and stores the admitted resource on `req.resource`. */
  require(kind: ResourceKind, param: string, need: Need) {
    return async (req: Request, _res: Response, next: NextFunction) => {
      req.resource = await this.check(req, kind, String(req.params[param] ?? ''), need);
      next();
    };
  }
}

/**
 * Resolvers for workflow-governed resources via the mirrored contract GETs (acting user in the
 * service JWT); district comes from the ward register. Support requests have no single-item GET in
 * the contract, so their resolver is added with the US6 routes.
 */
export function workflowResolvers(workflow: WorkflowClient, wards: WardDirectory): Partial<Record<ResourceKind, ResourceResolver>> {
  const enrich = async (actor: Actor, r: Resolved): Promise<Resolved> => {
    if (r.wardId) {
      const w = await wards.ward(actor, r.wardId);
      if (w) return { ...r, facilityId: r.facilityId ?? w.facilityId, districtCode: w.districtCode };
    }
    if (r.facilityId) {
      const f = await wards.facility(actor, r.facilityId);
      if (f) return { ...r, districtCode: f.districtCode };
    }
    return r;
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const owners = (...v: unknown[]) => v.filter((x): x is string => typeof x === 'string');
  const make =
    (kind: ResourceKind, path: (id: string) => string, ownerOf: (d: Record<string, unknown>) => string[]): ResourceResolver =>
    async (id, actor) => {
      if (!/^[a-f0-9]{24}$/.test(id)) return null;
      const d = await workflow.getResource(actor, path(id));
      if (!d) return null;
      return enrich(actor, { kind, id, wardId: str(d.wardId), facilityId: str(d.facilityId), ownerUserIds: ownerOf(d), doc: d });
    };
  return {
    task: make('task', (id) => `/ipc/v1/tasks/${id}`, (d) => owners(d.ownerUserId)),
    plan: make('plan', (id) => `/ipc/v1/plans/${id}`, () => []),
    assessment: make('assessment', (id) => `/ipc/v1/assessments/${id}`, (d) => owners(d.assessorUserId)),
  };
}
