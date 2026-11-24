import { useState } from 'react';
import { Button, ConfirmWithReason, StateBoundary, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useWardName } from '../plans/api.js';
import { useDate } from '../plans/format.js';
import { releaseErrorKey, useAssessments, useRelease, type Assessment } from './api.js';

function HeldItem({ a }: { a: Assessment }) {
  const { t } = useTranslation();
  const ward = useWardName();
  const date = useDate();
  const toast = useToast();
  const release = useRelease();
  const [open, setOpen] = useState(false);
  const name = ward(a.wardId);
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border-subtle p-4 shadow-1" aria-label={name}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-text">{name}</h3>
        <span className="text-sm text-text-muted">{t('comparison.release.completed', { date: date(a.completedAt) })}</span>
      </div>
      <p className="text-text">
        {t('comparison.release.score', { total: a.scores?.total ?? 0 })} · {t('comparison.versionN', { n: a.checklistVersion ?? 1 })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="secondary">
          <Link to={`/assessments/${a.id}/comparison`}>{t('comparison.open')}</Link>
        </Button>
        <Button onClick={() => setOpen(true)}>{t('comparison.release.action')}</Button>
      </div>
      <ConfirmWithReason
        open={open}
        onOpenChange={setOpen}
        title={t('comparison.release.confirmTitle')}
        description={t('comparison.release.confirmDescription', { ward: name })}
        reasons={[]}
        variant="primary"
        busy={release.isPending}
        labels={{
          confirm: t('comparison.release.confirm'),
          cancel: t('common.cancel'),
          close: t('common.close'),
          reason: t('comparison.release.note'),
          reasonPlaceholder: '',
          reasonRequired: '',
          note: t('comparison.release.note'),
          noteHint: t('comparison.release.noteHint'),
        }}
        onConfirm={({ reasonText }) =>
          release.mutate(
            { id: a.id, v: a.v, note: reasonText },
            {
              onSuccess: () => {
                setOpen(false);
                toast.show({ tone: 'success', title: t('comparison.release.done', { ward: name }) });
              },
              onError: (e) => toast.show({ tone: 'error', title: t(releaseErrorKey(e)) }),
            },
          )
        }
      />
    </li>
  );
}

/** DISTRICT_QM: completed external-auditor results held until released to the hospital (FR-024a). */
export function ReleaseQueue() {
  const { t } = useTranslation();
  const q = useAssessments({ status: 'completed', releaseState: 'held' });
  const items = q.data?.items ?? [];
  const messages = useStateMessages({ empty: { title: t('comparison.release.emptyTitle'), description: t('comparison.release.emptyDescription') } });
  return (
    <section aria-labelledby="release-queue" className="flex flex-col gap-3">
      <h2 id="release-queue" className="text-xl font-semibold text-text">{t('comparison.release.title')}</h2>
      <p className="text-text-muted">{t('comparison.release.intro')}</p>
      <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <ul className="flex flex-col gap-3" aria-label={t('comparison.release.title')}>
          {items.map((a) => <HeldItem key={a.id} a={a} />)}
        </ul>
      </StateBoundary>
    </section>
  );
}
