import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@ipc/contracts';
import { ApiError, NetworkError, apiRequest, newIdempotencyKey } from '../../lib/api.js';

type S = components['schemas'];
export type Plan = S['Plan'];
export type PlanDetail = S['PlanDetail'];
export type DraftTask = S['DraftTask'];
export type PlanTask = S['Task'];
export type PlanRevision = S['PlanRevision'];
export type DraftPlanUpdate = S['DraftPlanUpdate'];
export type PlanRevisionRequest = S['PlanRevisionRequest'];
export type UserSummary = S['UserSummary'];
export type Facility = S['Facility'];
export type RiskLevel = S['RiskLevel'];

interface Page<T> { items: T[]; nextCursor: string | null }

export const PLAN_KEYS = {
  list: (status: string) => ['plans', 'list', status] as const,
  plan: (id: string) => ['plans', id] as const,
  revisions: (id: string) => ['plans', id, 'revisions'] as const,
  users: (wardId: string) => ['users', 'ward', wardId] as const,
  facilities: ['facilities'] as const,
};

/** The draft queue polls, so a new draft shows within the SC-004 minute without a reload. */
export const usePlans = (status: 'draft' | 'active' | 'closed') =>
  useQuery({
    queryKey: PLAN_KEYS.list(status),
    queryFn: () => apiRequest<Page<Plan>>(`/ipc/v1/plans?status=${status}&limit=100`),
    refetchInterval: status === 'draft' ? 10_000 : false,
  });

export const usePlan = (id: string, enabled = true) =>
  useQuery({ queryKey: PLAN_KEYS.plan(id), queryFn: () => apiRequest<PlanDetail>(`/ipc/v1/plans/${id}`), enabled });

export const useRevisions = (id: string, enabled = true) =>
  useQuery({ queryKey: PLAN_KEYS.revisions(id), queryFn: () => apiRequest<Page<PlanRevision>>(`/ipc/v1/plans/${id}/revisions?limit=100`), enabled });

/** People who work in the ward (owner picker). */
export const useWardPeople = (wardId: string | undefined) =>
  useQuery({
    queryKey: PLAN_KEYS.users(wardId ?? ''),
    queryFn: () => apiRequest<Page<UserSummary>>(`/ipc/v1/users?wardId=${wardId}&limit=100`),
    enabled: !!wardId,
    staleTime: 5 * 60_000,
  });

export const useFacilities = () =>
  useQuery({ queryKey: PLAN_KEYS.facilities, queryFn: () => apiRequest<Page<Facility>>('/ipc/v1/facilities?limit=100'), staleTime: 5 * 60_000 });

/** Ward label from the facility register (`wardCode`), the id when unknown. */
export function useWardName() {
  const f = useFacilities().data;
  return (wardId: string) => {
    for (const fac of f?.items ?? []) {
      const w = (fac as Facility & { wards?: { id: string; wardCode: string; name?: string }[] }).wards?.find((x) => x.id === wardId);
      if (w) return `${fac.name} · ${w.name ?? w.wardCode}`;
    }
    return wardId;
  };
}

function useWrite<V>(fn: (v: V, key: string) => Promise<PlanDetail>) {
  const qc = useQueryClient();
  return useMutation({
    // One Idempotency-Key per attempt the user starts (a retry by the client reuses it).
    mutationFn: (v: V) => fn(v, newIdempotencyKey()),
    onSuccess: (plan) => {
      qc.setQueryData(PLAN_KEYS.plan(plan.id), plan);
      void qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export const useUpdateDraft = (id: string) =>
  useWrite<{ v: number; body: DraftPlanUpdate }>((x, key) =>
    apiRequest<PlanDetail>(`/ipc/v1/plans/${id}`, { method: 'PATCH', body: x.body, ifMatch: String(x.v), idempotencyKey: key }));

export const useApprove = (id: string) =>
  useWrite<{ v: number }>((x, key) => apiRequest<PlanDetail>(`/ipc/v1/plans/${id}/approval`, { method: 'POST', ifMatch: String(x.v), idempotencyKey: key }));

export const useRevise = (id: string) =>
  useWrite<{ v: number; body: PlanRevisionRequest }>((x, key) =>
    apiRequest<PlanDetail>(`/ipc/v1/plans/${id}/revisions`, { method: 'POST', body: x.body, ifMatch: String(x.v), idempotencyKey: key }));

/** i18n key for a failed write: what happened and what to do next. */
export function planErrorKey(e: unknown): string {
  if (e instanceof NetworkError) return 'plans.errors.offline';
  if (e instanceof ApiError) {
    if (e.code === 'VERSION_CONFLICT') return 'plans.errors.conflict';
    if (e.code === 'ELEVATE_UNAVAILABLE') return 'plans.errors.elevate';
    if (e.code === 'VALIDATION_FAILED') return 'plans.errors.validation';
    if (e.code === 'INVALID_TRANSITION') return 'plans.errors.transition';
    if (e.status === 403) return 'plans.errors.denied';
  }
  return 'plans.errors.generic';
}

export function problemDetail(e: unknown): string | undefined {
  return e instanceof ApiError && typeof e.problem.detail === 'string' ? e.problem.detail : undefined;
}

/** `datetime-local` value ↔ ISO. */
export const toLocalInput = (iso?: string) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : '');
export const fromDateInput = (v: string) => (v ? new Date(`${v}T00:00:00.000Z`).toISOString() : undefined);
