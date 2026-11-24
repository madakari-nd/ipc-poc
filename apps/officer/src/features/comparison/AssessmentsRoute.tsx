import { Button, DataTable, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMe } from '../auth/useMe.js';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { canSee } from '../../lib/nav.js';
import { useWardName } from '../plans/api.js';
import { useDate } from '../plans/format.js';
import { useAssessments, type Assessment } from './api.js';
import { ReleaseQueue } from './ReleaseQueue.js';

function CompletedList() {
  const { t } = useTranslation();
  const q = useAssessments({ status: 'completed' });
  const ward = useWardName();
  const date = useDate();
  const items = q.data?.items ?? [];
  const messages = useStateMessages({ empty: { title: t('comparison.list.emptyTitle'), description: t('comparison.list.emptyDescription') } });
  return (
    <section aria-labelledby="completed-assessments" className="flex flex-col gap-3">
      <h2 id="completed-assessments" className="text-xl font-semibold text-text">{t('comparison.list.title')}</h2>
      <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <DataTable<Assessment>
          caption={t('comparison.list.title')}
          hideCaption
          rows={items}
          getRowId={(a) => a.id}
          columns={[
            { key: 'ward', header: t('comparison.list.ward'), cell: (a) => ward(a.wardId) },
            { key: 'completed', header: t('comparison.completed'), cell: (a) => date(a.completedAt) },
            { key: 'assessor', header: t('comparison.assessor'), cell: (a) => t(`comparison.assessorType.${a.assessorType}`) },
            { key: 'score', header: t('comparison.trend.total'), cell: (a) => a.scores?.total ?? '—' },
            { key: 'release', header: t('comparison.list.visibility'), cell: (a) => t(`comparison.releaseState.${a.releaseState === 'n/a' ? 'na' : a.releaseState}`) },
            {
              key: 'open',
              header: t('comparison.list.actions'),
              cell: (a) => (
                <Link className="font-semibold text-text underline" to={`/assessments/${a.id}/comparison`} aria-label={t('comparison.openFor', { ward: ward(a.wardId) })}>
                  {t('comparison.open')}
                </Link>
              ),
            },
          ]}
        />
      </StateBoundary>
    </section>
  );
}

/** `/assessments`: DQM release queue (FR-024a) and completed assessments with their comparison (FR-024). */
export function AssessmentsRoute() {
  const { t } = useTranslation();
  const me = useMe().data;
  const messages = useStateMessages();
  if (!me) return null;
  const header = <PageHeader title={t('nav.assessments')} description={t('comparison.intro')} />;
  if (!canSee(me.activeRole, 'assessments')) {
    return (
      <>
        {header}
        <StateBoundary status="denied" messages={messages} deniedAction={<Button asChild variant="secondary"><Link to="/">{t('section.backHome')}</Link></Button>} />
      </>
    );
  }
  return (
    <>
      {header}
      <div className="flex flex-col gap-8">
        {me.activeRole === 'DISTRICT_QM' && <ReleaseQueue />}
        <CompletedList />
      </div>
    </>
  );
}
