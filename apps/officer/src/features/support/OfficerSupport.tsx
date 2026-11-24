import { useState } from 'react';
import { Button, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useSupportRequests, type ShortlistEntry, type SupportRequest } from './api.js';
import { AddToPlan } from './AddToPlan.js';
import { NewRequest } from './NewRequest.js';
import { RequestCard } from './RequestCard.js';
import { RequestSession } from './RequestSession.js';
import { Shortlist } from './Shortlist.js';

/** One request's next step for the officer: shortlist + session request, waiting, or agreed actions → plan. */
function Detail({ request }: { request: SupportRequest }) {
  const { t } = useTranslation();
  const [mentor, setMentor] = useState<ShortlistEntry | null>(null);
  const choosing = request.status === 'open' || request.status === 'rejected';
  return (
    <div className="flex flex-col gap-6">
      {choosing && <Shortlist request={request} onChoose={setMentor} />}
      {choosing && <RequestSession request={request} mentor={mentor} onClose={() => setMentor(null)} />}
      {(request.status === 'requested' || request.status === 'accepted') && <p className="text-sm text-text-muted">{t(`support.next.${request.status}`)}</p>}
      {request.status === 'held' && <AddToPlan request={request} />}
    </div>
  );
}

/** `/support` for the IPC officer / district QM: raise a request, choose a mentor, add agreed actions to the plan. */
export function OfficerSupport({ canRaise }: { canRaise: boolean }) {
  const { t } = useTranslation();
  const q = useSupportRequests();
  const [openId, setOpenId] = useState<string>();
  const items = q.data?.items ?? [];
  const messages = useStateMessages({ empty: { title: t('support.list.emptyTitle'), description: t('support.list.emptyDescription') } });
  return (
    <div className="flex flex-col gap-8">
      {canRaise && <NewRequest onCreated={(r) => setOpenId(r.id)} />}
      <section aria-labelledby="support-list" className="flex flex-col gap-3">
        <h2 id="support-list" className="text-xl font-semibold text-text">{t('support.list.title')}</h2>
        <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
          <ul className="flex flex-col gap-3" aria-label={t('support.list.title')}>
            {items.map((r) => (
              <RequestCard key={r.id} request={r}>
                {openId === r.id ? (
                  <Detail request={r} />
                ) : (
                  r.status !== 'closed' && <div><Button variant="secondary" onClick={() => setOpenId(r.id)}>{t('support.list.open')}</Button></div>
                )}
              </RequestCard>
            ))}
          </ul>
        </StateBoundary>
      </section>
    </div>
  );
}
