import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@ipc/contracts';
import { ApiError, NetworkError, apiRequest, newIdempotencyKey } from '../../lib/api.js';

type S = components['schemas'];
export type SupportRequest = S['SupportRequest'];
export type ShortlistEntry = S['ShortlistEntry'];
export type SupportRequestCreate = S['SupportRequestCreate'];
export type SessionRequestCreate = S['SessionRequestCreate'];
export type SupportOutcome = S['SupportOutcome'];
export type AgreedActionsToPlan = S['AgreedActionsToPlan'];
export type PlanRevision = S['PlanRevision'];
export type Skill = S['Skill'];
export type Language = S['Language'];

interface Page<T> { items: T[]; nextCursor: string | null }

export const SKILLS: Skill[] = ['hand_hygiene', 'ppe', 'waste', 'cleaning', 'device_bundles', 'sterilisation'];
export const LANGUAGES: Language[] = ['en', 'hi', 'kn'];

export const SUPPORT_KEYS = {
  list: ['support', 'list'] as const,
  shortlist: (id: string) => ['support', id, 'shortlist'] as const,
};

/**
 * Requests in scope. The Edge refreshes their status from ELEVATE mentoring on every read, so a
 * session accepted in ELEVATE shows here; the list polls while a request waits for the mentor.
 */
export const useSupportRequests = () =>
  useQuery({
    queryKey: SUPPORT_KEYS.list,
    queryFn: () => apiRequest<Page<SupportRequest>>('/ipc/v1/support-requests?limit=100'),
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((r) => r.status === 'requested') ? 15_000 : false),
  });

/** Ranked shortlist; `refresh` re-reads mentor availability from ELEVATE. */
export const useShortlist = (id: string, refresh: boolean) =>
  useQuery({
    queryKey: [...SUPPORT_KEYS.shortlist(id), refresh],
    queryFn: () => apiRequest<{ supportRequestId: string; computedAt: string; items: ShortlistEntry[] }>(`/ipc/v1/support-requests/${id}/shortlist${refresh ? '?refresh=true' : ''}`),
  });

function useSupportWrite<V, R>(fn: (v: V, key: string) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) => fn(v, newIdempotencyKey()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['support'] });
      void qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export const useCreateRequest = () =>
  useSupportWrite<SupportRequestCreate, SupportRequest>((body, key) => apiRequest('/ipc/v1/support-requests', { method: 'POST', body, idempotencyKey: key }));

export const useRequestSession = (id: string) =>
  useSupportWrite<{ v: number; body: SessionRequestCreate }, SupportRequest>((x, key) =>
    apiRequest(`/ipc/v1/support-requests/${id}/session-request`, { method: 'POST', body: x.body, ifMatch: String(x.v), idempotencyKey: key }));

export const useRecordOutcome = (id: string) =>
  useSupportWrite<{ v: number; body: SupportOutcome }, SupportRequest>((x, key) =>
    apiRequest(`/ipc/v1/support-requests/${id}/outcome`, { method: 'POST', body: x.body, ifMatch: String(x.v), idempotencyKey: key }));

export const useAddToPlan = (id: string) =>
  useSupportWrite<{ v: number; body: AgreedActionsToPlan }, PlanRevision>((x, key) =>
    apiRequest(`/ipc/v1/support-requests/${id}/plan-actions`, { method: 'POST', body: x.body, ifMatch: String(x.v), idempotencyKey: key }));

/** i18n key for a failed support write: what happened and what to do next. */
export function supportErrorKey(e: unknown): string {
  if (e instanceof NetworkError) return 'support.errors.offline';
  if (e instanceof ApiError) {
    if (e.code === 'VERSION_CONFLICT') return 'support.errors.conflict';
    if (e.code === 'ELEVATE_UNAVAILABLE') return 'support.errors.elevate';
    if (e.code === 'VALIDATION_FAILED') return 'support.errors.validation';
    if (e.code === 'INVALID_TRANSITION') return 'support.errors.transition';
    if (e.status === 403) return 'support.errors.denied';
  }
  return 'support.errors.generic';
}
