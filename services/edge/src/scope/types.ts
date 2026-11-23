/** Programme roles (contract `Role`). */
export const ROLES = [
  'STATE_ADMIN',
  'DISTRICT_QM',
  'IPC_OFFICER',
  'WARD_SUPERVISOR',
  'FRONTLINE',
  'MENTOR',
  'EXTERNAL_AUDITOR',
] as const;
export type Role = (typeof ROLES)[number];

export type ScopeLevel = 'state' | 'district' | 'facility' | 'wards' | 'own_tasks';

export interface ScopeShape {
  level: ScopeLevel;
  districtCode?: string;
  facilityId?: string;
  facilityIds?: string[];
  wardIds?: string[];
}

/** Contract `ScopeAssignment` (as returned by workflow `internalGetEffectiveScope`). */
export interface ScopeAssignment {
  id: string;
  v: number;
  createdAt: string;
  updatedAt: string;
  userId: string;
  role: Role;
  scope: ScopeShape;
  validFrom: string;
  validTo?: string;
  source: 'hr_import' | 'admin';
}

/** Response of `GET /internal/scopes/{userId}`. */
export interface EffectiveScopeResponse {
  userId: string;
  resolvedAt: string;
  mentorFacilityIds?: string[];
  assignments: ScopeAssignment[];
}

/** Server-derived scope of the caller, exposed as `req.scope` (Constitution III). */
export interface CallerScope {
  userId: string;
  activeRole: Role | null;
  roles: Role[];
  assignments: ScopeAssignment[];
  mentorFacilityIds: string[];
  resolvedAt: string;
}

/** Acting user carried to workflow in the service JWT `act` claim. */
export interface Actor {
  userId: string;
  role: Role | 'SYSTEM';
}

/** What the guard needs to know about a resource to decide scope and ownership. */
export interface ScopedResource {
  kind: ResourceKind;
  id: string;
  facilityId?: string;
  wardId?: string;
  districtCode?: string;
  /** Users who own or are assigned to the resource (task owner, uploader, assessor, chosen mentor). */
  ownerUserIds?: string[];
}

export type ResourceKind = 'evidence' | 'task' | 'plan' | 'assessment' | 'support_request';
