import type { BoundaryStatus, StateBoundaryMessages } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { ApiError, NetworkError } from './api.js';

/** Maps a query's state to a StateBoundary status. */
export function boundaryStatus(q: { isPending: boolean; isError: boolean; error: unknown }, isEmpty = false): BoundaryStatus {
  if (q.isPending) return 'loading';
  if (q.isError) return errorStatus(q.error);
  return isEmpty ? 'empty' : 'ready';
}

export function errorStatus(error: unknown): BoundaryStatus {
  if (error instanceof NetworkError || (typeof navigator !== 'undefined' && navigator.onLine === false)) return 'offline';
  if (error instanceof ApiError && error.status === 403) return 'denied';
  return 'error';
}

/** Translated messages for StateBoundary. */
export function useStateMessages(overrides: Partial<StateBoundaryMessages> = {}): StateBoundaryMessages {
  const { t } = useTranslation();
  return {
    loading: t('state.loading'),
    retry: t('state.retry'),
    empty: { title: t('state.empty.title'), description: t('state.empty.description') },
    error: { title: t('state.error.title'), description: t('state.error.description') },
    offline: { title: t('state.offline.title'), description: t('state.offline.description') },
    denied: { title: t('state.denied.title'), description: t('state.denied.description') },
    ...overrides,
  };
}
