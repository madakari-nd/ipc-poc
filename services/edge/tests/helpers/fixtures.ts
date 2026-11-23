import type { EffectiveScopeResponse, Role, ScopeShape } from '../../src/scope/types.js';

export const FA = '65a000000000000000000001'; // Hospital A (district D1)
export const FB = '65a000000000000000000002'; // Hospital B (district D2)
export const WA1 = '65b000000000000000000001';
export const WA2 = '65b000000000000000000002';
export const WB1 = '65b000000000000000000003';
export const TASK_A1 = '65c000000000000000000001'; // ward A1, owned by frontA1
export const TASK_B1 = '65c000000000000000000002'; // ward B1, owned by frontB1
export const ASSESS_A1 = '65d000000000000000000001'; // ward A1, assessor officerA
export const ASSESS_B1 = '65d000000000000000000002'; // ward B1, assessor officerB

export const FACILITIES = [
  {
    id: FA,
    facilityCode: 'HA',
    districtCode: 'D1',
    location: { lat: 12.97, lng: 77.59 },
    wards: [
      { id: WA1, wardCode: 'ICU', facilityId: FA, active: true },
      { id: WA2, wardCode: 'GEN', facilityId: FA, active: true },
    ],
  },
  {
    id: FB,
    facilityCode: 'HB',
    districtCode: 'D2',
    location: { lat: 13.5, lng: 78.0 },
    wards: [{ id: WB1, wardCode: 'ICU', facilityId: FB, active: true }],
  },
];

export const RESOURCES: Record<string, Record<string, unknown>> = {
  [`/ipc/v1/tasks/${TASK_A1}`]: { id: TASK_A1, wardId: WA1, ownerUserId: 'frontA1' },
  [`/ipc/v1/tasks/${TASK_B1}`]: { id: TASK_B1, wardId: WB1, ownerUserId: 'frontB1' },
  [`/ipc/v1/assessments/${ASSESS_A1}`]: { id: ASSESS_A1, wardId: WA1, facilityId: FA, assessorUserId: 'officerA' },
  [`/ipc/v1/assessments/${ASSESS_B1}`]: { id: ASSESS_B1, wardId: WB1, facilityId: FB, assessorUserId: 'officerB' },
};

const assignment = (userId: string, role: Role, scope: ScopeShape, i: number) => ({
  id: `65e0000000000000000000${String(i).padStart(2, '0')}`,
  v: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  userId,
  role,
  scope,
  validFrom: '2026-01-01T00:00:00.000Z',
  source: 'admin' as const,
});

const USERS: Record<string, [Role, ScopeShape] | null> = {
  stateAdmin: ['STATE_ADMIN', { level: 'state' }],
  dqmD1: ['DISTRICT_QM', { level: 'district', districtCode: 'D1' }],
  officerA: ['IPC_OFFICER', { level: 'facility', facilityId: FA }],
  officerB: ['IPC_OFFICER', { level: 'facility', facilityId: FB }],
  supervisorA: ['WARD_SUPERVISOR', { level: 'wards', wardIds: [WA1] }],
  frontA1: ['FRONTLINE', { level: 'own_tasks', wardIds: [WA1] }],
  frontA2: ['FRONTLINE', { level: 'own_tasks', wardIds: [WA1] }],
  frontB1: ['FRONTLINE', { level: 'own_tasks', wardIds: [WB1] }],
  mentor: ['MENTOR', { level: 'facility' }],
  auditor: ['EXTERNAL_AUDITOR', { level: 'facility', facilityIds: [FA] }],
  nobody: null,
};

export function scopeOf(userId: string): EffectiveScopeResponse {
  const u = USERS[userId];
  return {
    userId,
    resolvedAt: '2026-11-23T00:00:00.000Z',
    ...(userId === 'mentor' ? { mentorFacilityIds: [FA] } : {}),
    assignments: u ? [assignment(userId, u[0], u[1], Object.keys(USERS).indexOf(userId))] : [],
  };
}
