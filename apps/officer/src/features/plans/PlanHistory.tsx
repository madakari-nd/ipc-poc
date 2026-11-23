import { Button, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useRevisions } from './api.js';
import { useDate } from './format.js';

/** Numbered plan revisions with actor, role, reason and changes (FR-017, US3 AS6). */
export function PlanHistory({ planId }: { planId: string }) {
  const { t } = useTranslation();
  const q = useRevisions(planId);
  const date = useDate();
  const items = q.data?.items ?? [];
  const messages = useStateMessages({ empty: { title: t('plans.history.emptyTitle'), description: t('plans.history.emptyDescription') } });
  return (
    <section aria-labelledby="plan-history" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="plan-history" className="text-xl font-semibold text-text">{t('plans.history.title')}</h2>
        <Button asChild variant="ghost"><Link to={`/history/plan/${planId}`}>{t('plans.history.audit')}</Link></Button>
      </div>
      <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <ol className="flex flex-col gap-2" aria-label={t('plans.history.title')}>
          {items.map((r) => (
            <li key={r.id} className="rounded-md border border-border-subtle p-3">
              <p className="font-semibold text-text">{t('plans.revisionN', { n: r.revision })} · {date(r.createdAt)}</p>
              <p className="text-base text-text">{r.reason}</p>
              <p className="text-sm text-text-muted">
                {t('plans.history.by', { user: r.actorUserId, role: t(`roles.${r.role}`) })} ·{' '}
                {(['add', 'remove', 'update'] as const)
                  .map((op) => ({ op, n: r.changes.filter((c) => c.op === op).length }))
                  .filter((x) => x.n > 0)
                  .map((x) => t(`plans.history.${x.op}`, { count: x.n }))
                  .join(', ')}
              </p>
            </li>
          ))}
        </ol>
      </StateBoundary>
    </section>
  );
}
