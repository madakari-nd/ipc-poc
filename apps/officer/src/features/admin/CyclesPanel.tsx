import { useState } from 'react';
import { Button, DataTable, Field, StateBoundary, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { KEYS, useAdminWrite, useCycles, type Cycle } from './api.js';
import { Panel, WriteError, toIso, useFormatDate } from './common.js';

/** Cycles: target dates, status, and the cycle's own ELEVATE plan solution (FR-004, FR-018a). */
export function CyclesPanel() {
  const { t } = useTranslation();
  const fmt = useFormatDate();
  const toast = useToast();
  const q = useCycles();
  const messages = useStateMessages({ empty: { title: t('admin.cycles.empty'), description: t('admin.cycles.emptyHelp') } });
  const status = useAdminWrite<{ c: Cycle; status: Cycle['status'] }, Cycle>(
    ({ c, status: s }) => ({ path: `/ipc/v1/admin/cycles/${c.id}`, method: 'PATCH', body: { status: s }, ifMatch: c.v }),
    [KEYS.cycles],
  );
  const [form, setForm] = useState({ code: '', startsAt: '', endsAt: '', baselineBy: '', repeatBy: '' });
  const create = useAdminWrite<void, Cycle>(() => ({
    path: '/ipc/v1/admin/cycles',
    method: 'POST',
    body: {
      code: form.code.trim(), startsAt: toIso(form.startsAt), endsAt: toIso(form.endsAt),
      targetDates: { baselineBy: toIso(form.baselineBy), ...(form.repeatBy ? { repeatBy: toIso(form.repeatBy) } : {}) },
    },
  }), [KEYS.cycles]);
  const items = q.data?.items ?? [];
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <>
      <Panel title={t('admin.cycles.title')}>
        <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
          <DataTable
            caption={t('admin.cycles.title')}
            hideCaption
            columns={[
              { key: 'code', header: t('admin.cycles.code'), cell: (c) => c.code },
              { key: 'dates', header: t('admin.cycles.dates'), cell: (c) => `${fmt(c.startsAt)} – ${fmt(c.endsAt)}` },
              { key: 'baseline', header: t('admin.cycles.baselineBy'), cell: (c) => fmt(c.targetDates.baselineBy) },
              { key: 'status', header: t('admin.cycles.status'), cell: (c) => t(`admin.cycles.statuses.${c.status}`) },
              { key: 'plan', header: t('admin.cycles.planSolution'), cell: (c) => c.elevateSolutionIds?.plan ?? t('admin.cycles.none') },
              {
                key: 'act', header: t('admin.actions'),
                cell: (c) => (c.status === 'closed' ? null : (
                  <Button variant="secondary" busy={status.isPending} onClick={() => status.mutate({ c, status: c.status === 'planned' ? 'active' : 'closed' })}>
                    {t(c.status === 'planned' ? 'admin.cycles.activate' : 'admin.cycles.close')}
                  </Button>
                )),
              },
            ]}
            rows={items}
            getRowId={(c) => c.id}
          />
        </StateBoundary>
        <WriteError error={status.error} />
      </Panel>
      <Panel title={t('admin.cycles.newTitle')}>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label={t('admin.cycles.code')} hint={t('admin.cycles.codeHint')} value={form.code} maxLength={32} onChange={set('code')} />
          <Field label={t('admin.cycles.startsAt')} type="datetime-local" value={form.startsAt} onChange={set('startsAt')} />
          <Field label={t('admin.cycles.endsAt')} type="datetime-local" value={form.endsAt} onChange={set('endsAt')} />
          <Field label={t('admin.cycles.baselineBy')} type="datetime-local" value={form.baselineBy} onChange={set('baselineBy')} />
          <Field label={t('admin.cycles.repeatBy')} type="datetime-local" value={form.repeatBy} onChange={set('repeatBy')} />
        </div>
        <p className="text-sm text-text-muted">{t('admin.cycles.solutionNote')}</p>
        <div>
          <Button busy={create.isPending} onClick={() => create.mutate(undefined, { onSuccess: (c) => toast.show({ tone: 'success', title: t('admin.cycles.created', { code: c.code }) }) })}>
            {t('admin.cycles.create')}
          </Button>
        </div>
        <WriteError error={create.error} />
      </Panel>
    </>
  );
}
