import { describe, expect, it } from 'vitest';
import {
  ROLE_SCOPE_LEVELS,
  isAssignmentActive,
  resolveEffectiveScope,
  scopeViolations,
  validateScopeAssignment,
  type ScopeAssignmentInput,
} from '../../src/domain/scope.js';

const F1 = 'f'.repeat(24);
const F2 = 'e'.repeat(24);
const W1 = 'a'.repeat(24);
const W2 = 'b'.repeat(24);
const T0 = new Date('2026-11-01T00:00:00.000Z');
const T1 = new Date('2026-12-01T00:00:00.000Z');

function input(over: Partial<ScopeAssignmentInput>): ScopeAssignmentInput {
  return { userId: 'u-1', role: 'IPC_OFFICER', scope: { level: 'facility', facilityId: F1 }, validFrom: T0, ...over };
}

const VALIDATION = expect.objectContaining({ status: 422, code: 'VALIDATION_FAILED' }) as Error;

describe('role <-> scope level (data-model §1)', () => {
  it('declares the allowed levels for every role', () => {
    expect(ROLE_SCOPE_LEVELS).toEqual({
      STATE_ADMIN: ['state'],
      DISTRICT_QM: ['district'],
      IPC_OFFICER: ['facility'],
      WARD_SUPERVISOR: ['wards'],
      FRONTLINE: ['own_tasks', 'wards'],
      MENTOR: ['own_tasks'],
      EXTERNAL_AUDITOR: ['facility'],
    });
  });

  it.each([
    ['STATE_ADMIN', { level: 'state' }],
    ['DISTRICT_QM', { level: 'district', districtCode: 'D1' }],
    ['IPC_OFFICER', { level: 'facility', facilityId: F1 }],
    ['WARD_SUPERVISOR', { level: 'wards', facilityId: F1, wardIds: [W1, W2] }],
    ['FRONTLINE', { level: 'wards', facilityId: F1, wardIds: [W1] }],
    ['FRONTLINE', { level: 'own_tasks', facilityId: F1, wardIds: [W1] }],
    ['MENTOR', { level: 'own_tasks' }],
    ['EXTERNAL_AUDITOR', { level: 'facility', facilityIds: [F1, F2] }],
  ] as const)('accepts %s with %j', (role, scope) => {
    expect(scopeViolations(input({ role, scope: { ...scope } }))).toEqual([]);
  });

  it.each([
    ['FRONTLINE', { level: 'facility', facilityId: F1 }],
    ['WARD_SUPERVISOR', { level: 'facility', facilityId: F1 }],
    ['IPC_OFFICER', { level: 'district', districtCode: 'D1' }],
    ['DISTRICT_QM', { level: 'state' }],
    ['STATE_ADMIN', { level: 'district', districtCode: 'D1' }],
    ['MENTOR', { level: 'facility', facilityId: F1 }],
    ['EXTERNAL_AUDITOR', { level: 'wards', facilityId: F1, wardIds: [W1] }],
  ] as const)('refuses %s with level %j', (role, scope) => {
    expect(() => validateScopeAssignment(input({ role, scope: { ...scope } }))).toThrowError(VALIDATION);
  });

  it.each([
    ['DISTRICT_QM', { level: 'district' }],
    ['IPC_OFFICER', { level: 'facility' }],
    ['WARD_SUPERVISOR', { level: 'wards', facilityId: F1 }],
    ['WARD_SUPERVISOR', { level: 'wards', facilityId: F1, wardIds: [] }],
    ['WARD_SUPERVISOR', { level: 'wards', wardIds: [W1] }],
    ['EXTERNAL_AUDITOR', { level: 'facility' }],
    ['EXTERNAL_AUDITOR', { level: 'facility', facilityIds: [] }],
  ] as const)('refuses %s missing the target of %j', (role, scope) => {
    expect(() => validateScopeAssignment(input({ role, scope: { ...scope } }))).toThrowError(VALIDATION);
  });

  it('refuses malformed ids and duplicate wards', () => {
    expect(scopeViolations(input({ scope: { level: 'facility', facilityId: 'nope' } }))).not.toEqual([]);
    expect(
      scopeViolations(input({ role: 'WARD_SUPERVISOR', scope: { level: 'wards', facilityId: F1, wardIds: [W1, W1] } })),
    ).not.toEqual([]);
  });

  it('refuses an unknown role', () => {
    expect(() => validateScopeAssignment(input({ role: 'ROOT' as never }))).toThrowError(VALIDATION);
  });

  it('normalises: drops fields that do not belong to the level', () => {
    const out = validateScopeAssignment(
      input({ role: 'STATE_ADMIN', scope: { level: 'state', facilityId: F1, wardIds: [W1], districtCode: 'D1' } }),
    );
    expect(out.scope).toEqual({ level: 'state' });
    const ipc = validateScopeAssignment(input({ scope: { level: 'facility', facilityId: F1, wardIds: [W1] } }));
    expect(ipc.scope).toEqual({ level: 'facility', facilityId: F1 });
  });
});

describe('validity dates', () => {
  it('refuses validTo on or before validFrom', () => {
    expect(() => validateScopeAssignment(input({ validTo: T0 }))).toThrowError(VALIDATION);
    expect(() => validateScopeAssignment(input({ validFrom: T1, validTo: T0 }))).toThrowError(VALIDATION);
    expect(() => validateScopeAssignment(input({ validFrom: new Date('x') }))).toThrowError(VALIDATION);
  });

  it('is active from validFrom (inclusive) to validTo (exclusive)', () => {
    const a = { validFrom: T0, validTo: T1 };
    expect(isAssignmentActive(a, new Date(T0.getTime() - 1))).toBe(false);
    expect(isAssignmentActive(a, T0)).toBe(true);
    expect(isAssignmentActive(a, new Date(T1.getTime() - 1))).toBe(true);
    expect(isAssignmentActive(a, T1)).toBe(false);
    expect(isAssignmentActive({ validFrom: T0 }, new Date('2099-01-01'))).toBe(true);
    expect(isAssignmentActive({ validFrom: T0, validTo: null }, T1)).toBe(true);
  });
});

describe('resolveEffectiveScope', () => {
  const at = new Date('2026-11-15T00:00:00.000Z');
  const active = { id: '1', ...input({}) };
  const expired = { id: '2', ...input({ validFrom: new Date('2026-01-01'), validTo: new Date('2026-02-01') }) };
  const future = { id: '3', ...input({ validFrom: T1 }) };
  const corrupt = { id: '4', ...input({ role: 'FRONTLINE', scope: { level: 'state' } }) };

  it('keeps only active, rule-conforming assignments', () => {
    const r = resolveEffectiveScope({ userId: 'u-1', assignments: [active, expired, future, corrupt], at });
    expect(r.userId).toBe('u-1');
    expect(r.resolvedAt).toEqual(at);
    expect(r.assignments.map((a) => a.id)).toEqual(['1']);
    expect(r.mentorFacilityIds).toBeUndefined();
  });

  it('adds mentor facilities only when an active MENTOR assignment exists', () => {
    const mentor = { id: '5', ...input({ role: 'MENTOR', scope: { level: 'own_tasks' } }) };
    const r = resolveEffectiveScope({ userId: 'u-1', assignments: [mentor], at, mentorFacilityIds: [F2, F1, F2] });
    expect(r.mentorFacilityIds).toEqual([F2, F1]); // de-duplicated, sorted
    const notMentor = resolveEffectiveScope({ userId: 'u-1', assignments: [active], at, mentorFacilityIds: [F1] });
    expect(notMentor.mentorFacilityIds).toBeUndefined();
  });

  it('ignores assignments that belong to another user', () => {
    const other = { id: '6', ...input({ userId: 'u-2' }) };
    expect(resolveEffectiveScope({ userId: 'u-1', assignments: [other], at }).assignments).toEqual([]);
  });
});
