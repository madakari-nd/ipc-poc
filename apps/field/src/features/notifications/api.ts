import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@ipc/contracts';
import { apiRequest, newIdempotencyKey } from '../../lib/api.js';

type S = components['schemas'];
export type Notification = S['Notification'];
export type SmsConsent = S['SmsConsent'];

interface Page<T> { items: T[]; nextCursor: string | null }

export const NOTIFICATION_KEYS = {
  list: ['notifications', 'list'] as const,
  smsConsent: ['sms', 'consent'] as const,
};

/** My notifications, newest first, with the unread count. */
export const useNotifications = () =>
  useQuery({
    queryKey: NOTIFICATION_KEYS.list,
    queryFn: () => apiRequest<Page<Notification> & { unreadCount: number }>('/ipc/v1/notifications?limit=50'),
  });

export const useMarkNotificationRead = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest<Notification>(`/ipc/v1/notifications/${id}/read`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NOTIFICATION_KEYS.list });
      void qc.invalidateQueries({ queryKey: ['home'] });
    },
  });
};

/** Give or withdraw SMS stand-in consent (FR-021). */
export const useSmsConsent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (given: boolean) => apiRequest<SmsConsent>('/ipc/v1/me/sms-consent', { method: 'PUT', body: { given, source: 'field_app' }, idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NOTIFICATION_KEYS.smsConsent });
    },
  });
};
