import type { components } from '@ipc/contracts';
import { apiRequest, newIdempotencyKey } from '../../lib/api.js';
import type { AssessmentContext, AssessmentStart, FormBundle } from './draft.js';

type Facility = components['schemas']['Facility'];
type Cycle = components['schemas']['Cycle'];

/** One ward the caller assesses in the open cycle, with its assessment if one was started. */
export interface WardRow {
  wardId: string;
  wardName: string;
  wardType: string;
  facilityName: string;
  cycleId: string;
  cycleCode: string;
  assessmentId?: string;
  status?: AssessmentContext['status'];
}

/**
 * Wards in scope (server-derived, `listFacilities`), the open cycle (`listCycles`) and the caller's
 * own assessments (`listAssessments?view=assigned`). Online only; the device keeps its downloads.
 */
export async function fetchAssignedWards(): Promise<WardRow[]> {
  const [facilities, cycles, mine] = await Promise.all([
    apiRequest<{ items: Facility[] }>('/ipc/v1/facilities?limit=100'),
    apiRequest<{ items: Cycle[] }>('/ipc/v1/cycles?status=active&limit=100'),
    apiRequest<{ items: AssessmentContext[] }>('/ipc/v1/assessments?view=assigned&limit=100'),
  ]);
  const cycle = cycles.items[0];
  if (!cycle) return [];
  const latest = new Map<string, AssessmentContext>();
  for (const a of mine.items) {
    if (a.cycleId !== cycle.id) continue;
    const prev = latest.get(a.wardId);
    if (!prev || a.createdAt > prev.createdAt) latest.set(a.wardId, a);
  }
  return facilities.items.flatMap((f) =>
    (f.wards ?? [])
      .filter((w) => w.active)
      .map((w) => {
        const a = latest.get(w.id);
        return {
          wardId: w.id,
          wardName: w.name,
          wardType: w.wardType,
          facilityName: f.name,
          cycleId: cycle.id,
          cycleCode: cycle.code,
          ...(a ? { assessmentId: a.id, status: a.status } : {}),
        };
      }),
  );
}

/** `startAssessment`: online, when the ward is downloaded for offline use. */
export function startAssessment(wardId: string, cycleId: string): Promise<AssessmentStart> {
  return apiRequest<AssessmentStart>('/ipc/v1/assessments', { method: 'POST', body: { wardId, cycleId }, idempotencyKey: newIdempotencyKey() });
}

/** `getFormBundle`: refreshes the grace date of a downloaded version when the network is back. */
export function fetchBundle(assessmentId: string): Promise<FormBundle> {
  return apiRequest<FormBundle>(`/ipc/v1/assessments/${assessmentId}/form-bundle`);
}
