import { Button, DataTable, IconAlert, IconCheck, IconLock, IconUpload, StateBoundary, cn, useToast, type Column } from '@ipc/design-system';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import type { OutboxItemView } from '../../offline/outbox.js';
import { OUTBOX_KEY, useSession, useSignedIn } from '../session/SessionProvider.js';

const statusStyle = {
  pending: { cls: 'bg-feedback-info text-feedback-info-fg', icon: IconUpload },
  sent: { cls: 'bg-feedback-success text-feedback-success-fg', icon: IconCheck },
  needs_attention: { cls: 'bg-feedback-warning text-feedback-warning-fg', icon: IconAlert },
} as const;

/** FR-037: every queued item shows pending / sent / needs attention, with the next step. */
export function QueueList() {
  const { t, i18n } = useTranslation();
  const { outbox } = useSignedIn();
  const { requestSync } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const items = useQuery({ queryKey: OUTBOX_KEY, queryFn: () => outbox.list() });
  const messages = useStateMessages({ empty: { title: t('queue.empty.title'), description: t('queue.empty.description') } });
  const rows = items.data ?? [];

  const retry = async (id: string) => {
    await outbox.retry(id);
    await qc.invalidateQueries({ queryKey: OUTBOX_KEY });
    requestSync();
    toast.show({ tone: 'info', title: t('queue.retrying') });
  };

  const detail = (i: OutboxItemView) => {
    if (i.status === 'needs_attention' && i.attention) return t(`queue.attention.${i.attention}`, { code: i.problemCode ?? '' });
    if (i.blockedBy.length > 0) return t('queue.waitingFor');
    if (i.status === 'pending' && i.attempts > 0) return t('queue.willRetry', { time: new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(i.nextAttemptAt) });
    return '';
  };

  const columns: Column<OutboxItemView>[] = [
    {
      key: 'item',
      header: t('queue.columns.item'),
      cell: (i) => (
        <div className="flex flex-col">
          <span className="font-semibold">{i.label}</span>
          <span className="text-sm text-text-muted">{t(`queue.kind.${i.kind}`)}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: t('queue.columns.status'),
      cell: (i) => {
        const s = statusStyle[i.status];
        const Icon = s.icon;
        return (
          <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-sm font-semibold', s.cls)}>
            <Icon />
            {t(`queue.status.${i.status}`)}
          </span>
        );
      },
    },
    { key: 'detail', header: t('queue.columns.detail'), cell: (i) => <span className="text-sm">{detail(i)}</span> },
    {
      key: 'action',
      header: t('queue.columns.action'),
      cell: (i) => {
        if (i.readOnly) {
          return (
            <span className="inline-flex items-center gap-1 text-sm text-text-muted">
              <IconLock />
              {t('queue.readOnly')}
            </span>
          );
        }
        if (i.attention === 'conflict') {
          return (
            <Button asChild variant="secondary">
              <Link to={`/queue/${i.id}/review`}>{t('queue.review')}</Link>
            </Button>
          );
        }
        if (i.attention === 'retries_exhausted' || i.attention === 'rejected') {
          return (
            <Button variant="secondary" onClick={() => void retry(i.id)}>
              {t('queue.retry')}
            </Button>
          );
        }
        return null;
      },
    },
  ];

  return (
    <StateBoundary status={boundaryStatus(items, rows.length === 0)} messages={messages} onRetry={() => void items.refetch()} emptyAction={<Link to="/">{t('nav.home')}</Link>}>
      <DataTable caption={t('queue.title')} hideCaption columns={columns} rows={rows} getRowId={(i) => i.id} />
    </StateBoundary>
  );
}
