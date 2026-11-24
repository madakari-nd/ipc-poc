import { useEffect, useState } from 'react';
import { Button, Field, StateBoundary, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { KEYS, useAdminWrite, useRetentionPolicy, type RetentionPolicy } from './api.js';
import { Panel, WriteError } from './common.js';

/** Data retention (T128, NFR-010): evidence after plan closure, audit, other records. Dry-run in the POC. */
export function RetentionPanel() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useRetentionPolicy();
  const messages = useStateMessages({ empty: { title: t('admin.retention.emptyTitle'), description: t('admin.retention.emptyDescription') } });
  const [evidenceYears, setEvidenceYears] = useState('3');
  const [auditYears, setAuditYears] = useState('7');
  const [otherYears, setOtherYears] = useState('5');
  const [purgeMode, setPurgeMode] = useState<'dry_run' | 'enforce'>('dry_run');

  const current = q.data;
  useEffect(() => {
    if (current) {
      setEvidenceYears(String(current.evidenceYearsAfterPlanClosure));
      setAuditYears(String(current.auditYears));
      setOtherYears(String(current.otherYearsAfterProgrammeEnd));
      setPurgeMode(current.purgeMode);
    }
  }, [current]);

  const save = useAdminWrite<void, RetentionPolicy>(() => ({
    path: '/ipc/v1/admin/retention-policy',
    method: 'PUT',
    body: {
      evidenceYearsAfterPlanClosure: Number(evidenceYears),
      auditYears: Number(auditYears),
      otherYearsAfterProgrammeEnd: Number(otherYears),
      purgeMode,
      reason: t('admin.retention.changeReason'),
    },
    ifMatch: current?.v ?? 0,
  }), [KEYS.retention]);

  return (
    <Panel title={t('admin.retention.title')}>
      <p className="text-base text-text-muted">{t('admin.retention.help')}</p>
      <StateBoundary status={boundaryStatus(q, !current)} messages={messages} onRetry={() => void q.refetch()}>
        {current && (
          <form
            className="flex max-w-xl flex-col gap-4"
            aria-label={t('admin.retention.title')}
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(undefined, { onSuccess: () => toast.show({ tone: 'success', title: t('admin.retention.saved') }) });
            }}
          >
            <Field label={t('admin.retention.evidence')} type="number" min={1} max={50} required value={evidenceYears} onChange={(e) => setEvidenceYears(e.target.value)} />
            <Field label={t('admin.retention.audit')} type="number" min={1} max={50} required value={auditYears} onChange={(e) => setAuditYears(e.target.value)} />
            <Field label={t('admin.retention.other')} type="number" min={1} max={50} required value={otherYears} onChange={(e) => setOtherYears(e.target.value)} />
            <label className="flex items-center gap-3">
              <input type="checkbox" checked={purgeMode === 'enforce'} onChange={(e) => setPurgeMode(e.target.checked ? 'enforce' : 'dry_run')} className="h-6 w-6" />
              <span className="text-base text-text">{t('admin.retention.enforce')}</span>
            </label>
            <p className="text-sm text-text-muted">{t('admin.retention.dryRunNote')}</p>
            <div>
              <Button type="submit" busy={save.isPending}>{t('admin.save')}</Button>
            </div>
            <WriteError error={save.error} />
          </form>
        )}
      </StateBoundary>
    </Panel>
  );
}
