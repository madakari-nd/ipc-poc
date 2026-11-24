import { Button, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useSupportRequests } from './api.js';
import { OutcomeForm } from './OutcomeForm.js';
import { RequestCard } from './RequestCard.js';

/** MyRequests (mentor): requests sent to me; after accepting in ELEVATE and holding the session, record the outcome. */
export function MyRequests() {
  const { t } = useTranslation();
  const q = useSupportRequests();
  const items = q.data?.items ?? [];
  const messages = useStateMessages({ empty: { title: t('support.mine.emptyTitle'), description: t('support.mine.emptyDescription') } });
  return (
    <section aria-labelledby="support-mine" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="support-mine" className="text-xl font-semibold text-text">{t('support.mine.title')}</h2>
        <Button variant="secondary" busy={q.isFetching} onClick={() => void q.refetch()}>{t('support.mine.refresh')}</Button>
      </div>
      <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <ul className="flex flex-col gap-3" aria-label={t('support.mine.title')}>
          {items.map((r) => (
            <RequestCard key={r.id} request={r}>
              {r.status === 'requested' && <p className="text-sm text-text-muted">{t('support.mine.acceptInElevate')}</p>}
              {r.status === 'accepted' && <OutcomeForm request={r} />}
              {(r.status === 'held' || r.status === 'closed') && (
                <ol className="list-decimal pl-6 text-sm text-text" aria-label={t('support.outcome.agreed')}>
                  {(r.agreedActions ?? []).map((a, i) => <li key={i}>{a.text}</li>)}
                </ol>
              )}
            </RequestCard>
          ))}
        </ul>
      </StateBoundary>
    </section>
  );
}
