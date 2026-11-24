import { useState } from 'react';
import { Button, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useMarkNotificationRead, useNotifications, useSmsConsent } from './api.js';

/**
 * `/notifications` (US5, T102): the field worker's inbox (in-app messages, unread until opened) and
 * the SMS stand-in consent toggle (FR-021). Consent is stored on the profile; SMS is a scale-up
 * channel the pilot demonstrates with the stand-in.
 */
export function NotificationsRoute() {
  const { t, i18n } = useTranslation();
  const q = useNotifications();
  const markRead = useMarkNotificationRead();
  const smsConsent = useSmsConsent();
  const [consent, setConsent] = useState<boolean>();
  const items = q.data?.items ?? [];
  const messages = useStateMessages({ empty: { title: t('notifications.list.emptyTitle'), description: t('notifications.list.emptyDescription') } });
  const fmt = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const agreed = consent ?? (smsConsent.data ? smsConsent.data.given : false);

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="notifications-title" className="flex flex-col gap-3">
        <h1 id="notifications-title" className="text-xl font-semibold text-text">{t('nav.notifications')}</h1>
        <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
          <ul className="flex flex-col gap-3" aria-label={t('nav.notifications')}>
            {items.map((n) => (
              <li key={n.id} className="flex flex-wrap items-start gap-3 rounded-lg border border-border-subtle p-3">
                <div className="min-w-0 flex-1">
                  <p className={n.status === 'read' ? 'text-text-muted' : 'font-semibold text-text'}>{t(`notifications.templates.${n.templateCode}`, { defaultValue: n.templateCode })}</p>
                  <p className="text-sm text-text-muted">{fmt(n.createdAt)}</p>
                </div>
                {n.status !== 'read' && (
                  <Button variant="secondary" onClick={() => markRead.mutate(n.id)} disabled={markRead.isPending}>
                    {t('notifications.markRead')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </StateBoundary>
      </section>

      <section aria-labelledby="sms-consent-title" className="flex flex-col gap-2 rounded-lg border border-border-subtle p-4">
        <h2 id="sms-consent-title" className="text-lg font-semibold text-text">{t('notifications.sms.title')}</h2>
        <p className="text-sm text-text-muted">{t('notifications.sms.description')}</p>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={agreed}
            disabled={smsConsent.isPending}
            onChange={(e) => {
              const next = e.target.checked;
              setConsent(next);
              smsConsent.mutate(next);
            }}
            className="h-6 w-6"
          />
          <span className="text-base text-text">{t('notifications.sms.consentLabel')}</span>
        </label>
      </section>
    </div>
  );
}
