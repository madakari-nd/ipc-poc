import { Problem } from '@ipc/platform';

export const ROLES = [
  'STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'FRONTLINE', 'MENTOR', 'EXTERNAL_AUDITOR',
] as const;
export type Role = (typeof ROLES)[number];

export const SCOPE_LEVELS = ['state', 'district', 'facility', 'wards', 'own_tasks'] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

/**
 * Role ↔ scope-level rule (data-model §1). MENTOR has no static place scope: its facilities are
 * derived from accepted SupportRequests. EXTERNAL_AUDITOR holds a facility list (read-only on plans).
 */
export const ROLE_SCOPE_LEVELS: Readonly<Record<Role, readonly ScopeLevel[]>> = {
  STATE_ADMIN: ['state'],
  DISTRICT_QM: ['district'],
  IPC_OFFICER: ['facility'],
  WARD_SUPERVISOR: ['wards'],
  FRONTLINE: ['own_tasks', 'wards'],
  MENTOR: ['own_tasks'],
  EXTERNAL_AUDITOR: ['facility'],
};

export interface Scope {
  level: ScopeLevel;
  districtCode?: string;
  facilityId?: string;
  facilityIds?: readonly string[];
  wardIds?: readonly string[];
}

export interface ScopeAssignmentInput {
  userId: string;
  role: Role;
  scope: Scope;
  validFrom: Date;
  validTo?: Date | null;
}

export interface Validity { validFrom: Date; validTo?: Date | null }

const OBJECT_ID = /^[a-f0-9]{24}$/;

export interface Violation { path: string; message: string }

function ids(path: string, list: unknown, out: Violation[]): void {
  if (!Array.isArray(list) || list.length === 0) {
    out.push({ path, message: 'must list at least one id' });
    return;
  }
  if (list.some((x) => typeof x !== 'string' || !OBJECT_ID.test(x))) out.push({ path, message: 'must contain ObjectIds' });
  if (new Set(list).size !== list.length) out.push({ path, message: 'must not repeat an id' });
}

function oid(path: string, v: unknown, out: Violation[]): void {
  if (typeof v !== 'string' || !OBJECT_ID.test(v)) out.push({ path, message: 'is required and must be an ObjectId' });
}

/** All rule violations for an assignment; empty when it conforms. */
export function scopeViolations(a: ScopeAssignmentInput): Violation[] {
  const out: Violation[] = [];
  const allowed = ROLE_SCOPE_LEVELS[a.role] as readonly ScopeLevel[] | undefined;
  if (!allowed) return [{ path: 'role', message: 'unknown role' }];
  if (!allowed.includes(a.scope?.level)) {
    return [{ path: 'scope.level', message: `${a.role} needs scope level ${allowed.join(' or ')}` }];
  }
  const s = a.scope;
  switch (s.level) {
    case 'district':
      if (typeof s.districtCode !== 'string' || s.districtCode.length === 0 || s.districtCode.length > 32) {
        out.push({ path: 'scope.districtCode', message: 'is required (max 32 characters)' });
      }
      break;
    case 'facility':
      if (a.role === 'EXTERNAL_AUDITOR') ids('scope.facilityIds', s.facilityIds, out);
      else oid('scope.facilityId', s.facilityId, out);
      break;
    case 'wards':
      oid('scope.facilityId', s.facilityId, out);
      ids('scope.wardIds', s.wardIds, out);
      break;
    case 'own_tasks':
      if (s.facilityId !== undefined) oid('scope.facilityId', s.facilityId, out);
      if (s.wardIds !== undefined && s.wardIds.length > 0) ids('scope.wardIds', s.wardIds, out);
      break;
    case 'state':
      break;
  }
  const from = a.validFrom instanceof Date ? a.validFrom.getTime() : Number.NaN;
  if (Number.isNaN(from)) out.push({ path: 'validFrom', message: 'is required and must be a date-time' });
  if (a.validTo != null) {
    const to = a.validTo instanceof Date ? a.validTo.getTime() : Number.NaN;
    if (Number.isNaN(to)) out.push({ path: 'validTo', message: 'must be a date-time' });
    else if (!Number.isNaN(from) && to <= from) out.push({ path: 'validTo', message: 'must be after validFrom' });
  }
  return out;
}

/** Keeps only the scope fields that belong to the level (client extras never leak into scope). */
export function normaliseScope(role: Role, s: Scope): Scope {
  switch (s.level) {
    case 'state': return { level: 'state' };
    case 'district': return { level: 'district', districtCode: s.districtCode! };
    case 'facility':
      return role === 'EXTERNAL_AUDITOR'
        ? { level: 'facility', facilityIds: [...s.facilityIds!] }
        : { level: 'facility', facilityId: s.facilityId! };
    case 'wards': return { level: 'wards', facilityId: s.facilityId!, wardIds: [...s.wardIds!] };
    case 'own_tasks':
      return {
        level: 'own_tasks',
        ...(s.facilityId ? { facilityId: s.facilityId } : {}),
        ...(s.wardIds?.length ? { wardIds: [...s.wardIds] } : {}),
      };
  }
}

/** Validates and normalises; throws 422 VALIDATION_FAILED with field errors. */
export function validateScopeAssignment(a: ScopeAssignmentInput): ScopeAssignmentInput {
  const errors = scopeViolations(a);
  if (errors.length) throw Problem.unprocessable('VALIDATION_FAILED', 'Scope does not fit the role', { errors });
  return { ...a, scope: normaliseScope(a.role, a.scope), validTo: a.validTo ?? undefined };
}

/** Active on [validFrom, validTo). */
export function isAssignmentActive(a: Validity, at: Date): boolean {
  const t = at.getTime();
  return a.validFrom.getTime() <= t && (a.validTo == null || t < a.validTo.getTime());
}

export interface EffectiveScope<A> {
  userId: string;
  resolvedAt: Date;
  assignments: A[];
  mentorFacilityIds?: string[];
}

/**
 * Effective scope at `at`: active assignments of this user that still satisfy the role rules
 * (defence in depth against bad stored data), plus mentor facilities for an active MENTOR.
 */
export function resolveEffectiveScope<A extends ScopeAssignmentInput>(args: {
  userId: string;
  assignments: A[];
  at: Date;
  mentorFacilityIds?: string[];
}): EffectiveScope<A> {
  const assignments = args.assignments.filter(
    (a) => a.userId === args.userId && isAssignmentActive(a, args.at) && scopeViolations(a).length === 0,
  );
  const isMentor = assignments.some((a) => a.role === 'MENTOR');
  return {
    userId: args.userId,
    resolvedAt: args.at,
    assignments,
    ...(isMentor ? { mentorFacilityIds: [...new Set(args.mentorFacilityIds ?? [])].sort() } : {}),
  };
}
