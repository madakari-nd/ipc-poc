import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@ipc/contracts';
import { ApiError, NetworkError, apiRequest, newIdempotencyKey } from '../../lib/api.js';

type S = components['schemas'];
export type Assessment = S['AssessmentContext'];
export type Comparison = S['Comparison'];
export type Trend = S['Trend'];

interface Page<T> { items: T[]; nextCursor: string | null }

export const COMPARISON_KEYS = {
  list: (q: string) => ['assessments', 'list', q] as const,
  assessment: (id: string) => ['assessments', id] as const,
  comparison: (id: string) => ['assessments', id, 'comparison'] as const,
  trend: (wardId: string) => ['wards', wardId, 'trend'] as const,
};

/** Completed assessments in scope (held external results only reach the auditor and the district QM). */
export const useAssessments = (q: { status?: 'completed'; releaseState?: 'held' }) => {
  const p = new URLSearchParams({ limit: '100', ...(q.status ? { status: q.status } : {}), ...(q.releaseState ? { releaseState: q.releaseState } : {}) }).toString();
  return useQuery({ queryKey: COMPARISON_KEYS.list(p), queryFn: () => apiRequest<Page<Assessment>>(`/ipc/v1/assessments?${p}`) });
};

export const useAssessment = (id: string) =>
  useQuery({ queryKey: COMPARISON_KEYS.assessment(id), queryFn: () => apiRequest<Assessment>(`/ipc/v1/assessments/${id}`) });

export const useComparison = (id: string) =>
  useQuery({ queryKey: COMPARISON_KEYS.comparison(id), queryFn: () => apiRequest<Comparison>(`/ipc/v1/assessments/${id}/comparison`) });

export const useTrend = (wardId: string | undefined) =>
  useQuery({ queryKey: COMPARISON_KEYS.trend(wardId ?? ''), queryFn: () => apiRequest<Trend>(`/ipc/v1/wards/${wardId}/trend`), enabled: !!wardId });

/** `releaseAssessment` (DISTRICT_QM): one Idempotency-Key per attempt, If-Match = the version shown. */
export function useRelease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (x: { id: string; v: number; note?: string }) =>
      apiRequest<Assessment>(`/ipc/v1/assessments/${x.id}/release`, {
        method: 'POST',
        body: x.note ? { note: x.note } : {},
        ifMatch: String(x.v),
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['assessments'] }),
  });
}

/** i18n key for a failed release: what happened and what to do next. */
export function releaseErrorKey(e: unknown): string {
  if (e instanceof NetworkError) return 'comparison.errors.offline';
  if (e instanceof ApiError) {
    if (e.code === 'VERSION_CONFLICT') return 'comparison.errors.conflict';
    if (e.code === 'INVALID_TRANSITION') return 'comparison.errors.transition';
    if (e.status === 403) return 'comparison.errors.denied';
  }
  return 'comparison.errors.generic';
}
