import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@ipc/contracts';
import { ApiError, NetworkError, apiRequest, newIdempotencyKey, type Problem } from '../../lib/api.js';

type S = components['schemas'];
export type ImportJob = S['ImportJob'];
export type ScopeAssignment = S['ScopeAssignment'];
export type Cycle = S['Cycle'];
export type ChecklistVersion = S['ChecklistVersion'];
export type RiskDefault = S['RiskDefault'];
export type EscalationRule = S['EscalationRule'];
export type DemoClock = S['DemoClock'];
export type Facility = S['Facility'];
export type RiskLevel = S['RiskLevel'];
export type Role = S['Role'];

interface Page<T> { items: T[]; nextCursor: string | null }

export const KEYS = {
  scopes: ['admin', 'scopes'] as const,
  cycles: ['cycles'] as const,
  checklists: ['checklists'] as const,
  checklist: (id: string) => ['checklists', id] as const,
  risk: ['admin', 'risk-defaults'] as const,
  rules: ['admin', 'escalation-rules'] as const,
  clock: ['demo', 'clock'] as const,
  facilities: ['facilities'] as const,
  importJob: (id: string) => ['admin', 'imports', id] as const,
};

export const useScopeAssignments = (role?: string) =>
  useQuery({ queryKey: [...KEYS.scopes, role ?? ''], queryFn: () => apiRequest<Page<ScopeAssignment>>(`/ipc/v1/admin/scope-assignments?limit=100${role ? `&role=${role}` : ''}`) });
export const useCycles = () => useQuery({ queryKey: KEYS.cycles, queryFn: () => apiRequest<Page<Cycle>>('/ipc/v1/cycles?limit=100') });
export const useChecklists = () => useQuery({ queryKey: KEYS.checklists, queryFn: () => apiRequest<Page<ChecklistVersion>>('/ipc/v1/checklists?limit=100') });
export const useChecklist = (id: string | undefined) =>
  useQuery({ queryKey: KEYS.checklist(id ?? ''), queryFn: () => apiRequest<ChecklistVersion>(`/ipc/v1/checklists/${id}`), enabled: !!id });
export const useRiskDefaults = () => useQuery({ queryKey: KEYS.risk, queryFn: () => apiRequest<{ items: RiskDefault[] }>('/ipc/v1/admin/risk-defaults') });
export const useEscalationRules = () => useQuery({ queryKey: KEYS.rules, queryFn: () => apiRequest<{ items: EscalationRule[] }>('/ipc/v1/admin/escalation-rules') });
export const useFacilities = () => useQuery({ queryKey: KEYS.facilities, queryFn: () => apiRequest<Page<Facility>>('/ipc/v1/facilities?limit=100') });
export const useDemoClock = (enabled = true) =>
  useQuery({ queryKey: KEYS.clock, queryFn: () => apiRequest<DemoClock>('/ipc/v1/demo/clock'), enabled, refetchInterval: 60_000 });

export const useImportJob = (id: string | undefined) =>
  useQuery({
    queryKey: KEYS.importJob(id ?? ''),
    queryFn: () => apiRequest<ImportJob>(`/ipc/v1/admin/imports/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ['queued', 'running'].includes(q.state.data.status) ? 2000 : false),
  });

/** Writes invalidate what they change; the caller shows success/failure. */
export function useAdminWrite<TBody, TResult>(
  build: (v: TBody) => { path: string; method: 'POST' | 'PUT' | 'PATCH'; body?: unknown; ifMatch?: number },
  invalidate: readonly (readonly string[])[],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: TBody) => {
      const r = build(v);
      return apiRequest<TResult>(r.path, { method: r.method, body: r.body, ...(r.ifMatch !== undefined ? { ifMatch: String(r.ifMatch) } : {}) });
    },
    onSuccess: () => Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k }))),
  });
}

/**
 * createImport is multipart (contract ImportUpload), so it is sent with FormData instead of the JSON
 * client; the session cookie, CSRF token and Idempotency-Key are the same.
 */
export async function uploadImport(kind: 'facility' | 'hr', file: File, csrfToken: string): Promise<ImportJob> {
  const form = new FormData();
  form.append('kind', kind);
  form.append('file', file, file.name);
  const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
  let res: Response;
  try {
    res = await fetch(`${base}/ipc/v1/admin/imports`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json, application/problem+json', 'X-CSRF-Token': csrfToken, 'Idempotency-Key': newIdempotencyKey() },
      body: form,
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : 'network error');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const p = data as Partial<Problem>;
    throw new ApiError(res.status, { ...p, code: p.code ?? 'INTERNAL_ERROR', title: p.title ?? res.statusText, status: res.status });
  }
  return data as unknown as ImportJob;
}

/** Problem code → translation key under `admin.errors`, with a generic fallback. */
export function errorKey(e: unknown): string {
  if (e instanceof NetworkError) return 'admin.errors.offline';
  if (e instanceof ApiError) {
    const known = ['CHECKLIST_PUBLISHED', 'VERSION_CONFLICT', 'VALIDATION_FAILED', 'ELEVATE_UNAVAILABLE', 'DEMO_MODE_DISABLED', 'ROLE_DENIED'];
    if (known.includes(e.code)) return `admin.errors.${e.code}`;
  }
  return 'admin.errors.generic';
}

/** Field errors of a VALIDATION_FAILED problem, joined for display. */
export function fieldErrors(e: unknown): string | undefined {
  if (!(e instanceof ApiError)) return undefined;
  const errs = e.problem.errors as { path: string; message: string }[] | undefined;
  return errs?.length ? errs.map((x) => `${x.path}: ${x.message}`).join('; ') : e.problem.detail;
}
