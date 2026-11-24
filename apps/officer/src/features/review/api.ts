import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@ipc/contracts';
import { ApiError, NetworkError, apiRequest, newIdempotencyKey } from '../../lib/api.js';

type S = components['schemas'];
export type Task = S['Task'];
export type TaskHistory = S['TaskHistory'];
export type EvidenceItem = S['EvidenceItem'];
export type SignedUrl = S['SignedUrl'];
export type UserSummary = S['UserSummary'];
export type ReasonCode = S['DecisionReasonCode'];
export type TaskView = 'review_queue' | 'validation_queue' | 'ward' | 'needs_reassignment';

interface Page<T> { items: T[]; nextCursor: string | null }

/** FR-014 reason list (contract DecisionReasonCode). */
export const RETURN_REASONS: ReasonCode[] = ['EVIDENCE_UNCLEAR', 'EVIDENCE_INCOMPLETE', 'WRONG_LOCATION_OR_ITEM', 'STANDARD_NOT_MET', 'PATIENT_DATA_VISIBLE', 'OTHER'];
export const ACCEPT_REASONS: ReasonCode[] = ['MEETS_STANDARD', 'MEETS_STANDARD_WITH_NOTE'];

export const TASK_KEYS = {
  queue: (view: TaskView) => ['tasks', 'queue', view] as const,
  task: (id: string) => ['tasks', id] as const,
  history: (id: string) => ['tasks', id, 'history'] as const,
  evidence: (id: string) => ['evidence', id] as const,
  people: (wardId: string) => ['users', 'ward', wardId] as const,
};

/** Queues poll so new submissions appear without a reload. */
export const useTaskQueue = (view: TaskView) =>
  useQuery({ queryKey: TASK_KEYS.queue(view), queryFn: () => apiRequest<Page<Task>>(`/ipc/v1/tasks?view=${view}&limit=100`), refetchInterval: 15_000 });

export const useTask = (id: string) => useQuery({ queryKey: TASK_KEYS.task(id), queryFn: () => apiRequest<Task>(`/ipc/v1/tasks/${id}`) });

export const useTaskHistory = (id: string) => useQuery({ queryKey: TASK_KEYS.history(id), queryFn: () => apiRequest<TaskHistory>(`/ipc/v1/tasks/${id}/history`) });

export const useEvidence = (id: string) => useQuery({ queryKey: TASK_KEYS.evidence(id), queryFn: () => apiRequest<EvidenceItem>(`/ipc/v1/evidence/${id}`) });

/** A fresh signed URL (at most 300 s) each time the viewer opens the file (FR-029). */
export const downloadLink = (id: string) => apiRequest<SignedUrl>(`/ipc/v1/evidence/${id}/download-link`);

export const useWardPeople = (wardId: string | undefined) =>
  useQuery({
    queryKey: TASK_KEYS.people(wardId ?? ''),
    queryFn: () => apiRequest<Page<UserSummary>>(`/ipc/v1/users?wardId=${wardId}&limit=100`),
    enabled: !!wardId,
    staleTime: 5 * 60_000,
  });

export type TaskWrite =
  | { kind: 'accept'; reasonCode?: string; reasonText?: string }
  | { kind: 'return' | 'validate' | 'validation_return'; reasonCode: string; reasonText?: string }
  | { kind: 'reassign'; newOwnerUserId: string; reason: string }
  | { kind: 'block'; blocked: boolean; reason?: string };

const PATH: Record<TaskWrite['kind'], string> = {
  accept: 'acceptance', return: 'return', validate: 'validation', validation_return: 'validation-return', reassign: 'reassignment', block: 'blocked-flag',
};

function bodyOf(w: TaskWrite): Record<string, unknown> {
  return Object.fromEntries(Object.entries(w).filter(([k, v]) => k !== 'kind' && v !== undefined && v !== ''));
}

/** One write on the task with its version (If-Match): a stale version answers 409 with the current task. */
export function useTaskWrite(task: Task | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (w: TaskWrite) =>
      apiRequest<Task>(`/ipc/v1/tasks/${task!.id}/${PATH[w.kind]}`, {
        method: w.kind === 'block' ? 'PUT' : 'POST', body: bodyOf(w), ifMatch: String(task!.v), idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (t) => {
      qc.setQueryData(TASK_KEYS.task(t.id), t);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT' && task) void qc.invalidateQueries({ queryKey: TASK_KEYS.task(task.id) });
    },
  });
}

/** FR-032: the reviewer deletes media that shows a patient (content removed, metadata and audit kept). */
export function useDeletePatientData(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { evidence: EvidenceItem; reasonText?: string }) =>
      apiRequest<EvidenceItem>(`/ipc/v1/evidence/${v.evidence.id}/patient-data-deletion`, {
        method: 'POST', body: { reasonCode: 'PATIENT_DATA_VISIBLE', ...(v.reasonText ? { reasonText: v.reasonText } : {}) },
        ifMatch: String(v.evidence.v), idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (ev) => {
      qc.setQueryData(TASK_KEYS.evidence(ev.id), ev);
      void qc.invalidateQueries({ queryKey: TASK_KEYS.history(taskId) });
    },
  });
}

/** i18n key for a failed write: what happened and what to do next. */
export function reviewErrorKey(e: unknown): string {
  if (e instanceof NetworkError) return 'review.errors.offline';
  if (e instanceof ApiError) {
    if (e.code === 'VERSION_CONFLICT') return 'review.errors.conflict';
    if (e.code === 'INVALID_TRANSITION') return 'review.errors.transition';
    if (e.code === 'VALIDATION_FAILED') return 'review.errors.validation';
    if (e.code === 'STORAGE_UNAVAILABLE') return 'review.errors.storage';
    if (e.status === 403) return 'review.errors.denied';
  }
  return 'review.errors.generic';
}
