import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@ipc/contracts';
import { apiRequest, newIdempotencyKey } from '../../lib/api.js';

type S = components['schemas'];
export type Escalation = S['Escalation'];
export type Notification = S['Notification'];
export type SweepResult = S['SweepResult'];

interface Page<T> { items: T[]; nextCursor: string | null }

export const ESCALATION_KEYS = {
  list: ['escalations', 'list'] as const,
  notifications: ['notifications', 'list'] as const,
};

/** Escalations within my scope or targeted to me. */
export const useEscalations = () =>
  useQuery({
    queryKey: ESCALATION_KEYS.list,
    queryFn: () => apiRequest<Page<Escalation>>('/ipc/v1/escalations?limit=100'),
  });

/** My notifications, newest first, with the unread count. */
export const useNotifications = () =>
  useQuery({
    queryKey: ESCALATION_KEYS.notifications,
    queryFn: () => apiRequest<Page<Notification> & { unreadCount: number }>('/ipc/v1/notifications?limit=100'),
  });

/** A ward supervisor raises a manual escalation for a blocker. */
export const useRaiseManualEscalation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, reason }: { taskId: string; reason: string }) =>
      apiRequest<Escalation>(`/ipc/v1/tasks/${taskId}/escalations`, { method: 'POST', body: { reason }, idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ESCALATION_KEYS.list });
      void qc.invalidateQueries({ queryKey: ['home'] });
    },
  });
};

/** Demo: run the escalation sweep now (STATE_ADMIN only). */
export const useRunEscalationSweep = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<SweepResult>('/ipc/v1/demo/escalation-sweep', { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ESCALATION_KEYS.list });
      void qc.invalidateQueries({ queryKey: ['home'] });
    },
  });
};

/** Mark one notification as read. */
export const useMarkNotificationRead = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest<Notification>(`/ipc/v1/notifications/${id}/read`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ESCALATION_KEYS.notifications });
      void qc.invalidateQueries({ queryKey: ['home'] });
    },
  });
};
