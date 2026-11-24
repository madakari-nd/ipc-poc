import { Button, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useMarkNotificationRead, useNotifications } from './api.js';

/**
 * `/notifications` (US5, T102): my notifications, newest first, with the unread count. In-app
 * messages are stored unread until opened; email and SMS delivery status are shown alongside.
 */
export function NotificationsRoute() {
  const { t, i18n } = useTranslation();
  const q = useNotifications();
  const markRead = useMarkNotificationRead();
  const items = q.data?.items ?? [];
  const unreadCount = q.data?.unreadCount ?? 0;
  const messages = useStateMessages({ empty: { title: t('notifications.list.emptyTitle'), description: t('notifications.list.emptyDescription') } });
  const fmt = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  return (
    <>
      <PageHeader title={t('notifications.title')} description={t('notifications.unread', { count: unreadCount })} />
      <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <ul className="flex flex-col gap-3" aria-label={t('notifications.title')}>
          {items.map((n) => (
            <li key={n.id} className="flex flex-wrap items-start gap-3 rounded-lg border border-border-subtle p-4 shadow-1">
              <div className="min-w-0 flex-1">
                <p className={n.status === 'read' ? 'text-text-muted' : 'font-semibold text-text'}>{t(`notifications.templates.${n.templateCode}`, { defaultValue: n.templateCode })}</p>
                <p className="text-sm text-text-muted">{fmt(n.createdAt)} · {t(`notifications.channels.${n.channel}`)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-border-subtle bg-surface-muted px-2 py-0.5 text-sm font-semibold text-text">{t(`notifications.status.${n.status}`)}</span>
                {n.status !== 'read' && (
                  <Button variant="secondary" onClick={() => markRead.mutate(n.id)} disabled={markRead.isPending}>
                    {t('notifications.markRead')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </StateBoundary>
    </>
  );
}
