import { RiskChip, StateBoundary, StatusChip } from '@ipc/design-system';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useSignedIn } from '../session/SessionProvider.js';
import { MY_TASKS_KEY, loadMyTasks } from './api.js';

/** US4: the owner's open tasks, also offline (encrypted device cache). */
export function MyTasks() {
  const { t, i18n } = useTranslation();
  const { db, key } = useSignedIn();
  const q = useQuery({ queryKey: MY_TASKS_KEY, queryFn: () => loadMyTasks(db, key), retry: false });
  const messages = useStateMessages({ empty: { title: t('tasks.empty.title'), description: t('tasks.empty.description') } });
  const items = q.data?.items ?? [];
  const fmt = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(iso));
  const title = (x: (typeof items)[number]) => (x.title as Record<string, string | undefined>)[i18n.language] ?? x.title.en;

  return (
    <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
      {q.data?.offline && (
        <p role="status" className="mb-4 rounded-md bg-feedback-warning p-3 text-feedback-warning-fg">
          {t('tasks.offlineList', { time: q.data.updatedAt ? new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short', dateStyle: 'short' }).format(q.data.updatedAt) : '' })}
        </p>
      )}
      <ul aria-label={t('tasks.listLabel')} className="flex flex-col gap-3">
        {items.map((x) => (
          <li key={x.id} aria-label={title(x)} className="rounded-md border border-border-subtle bg-surface p-4">
            <div className="flex flex-col gap-2">
              <Link to={`/tasks/${x.id}`} className="text-lg font-semibold text-action-primary underline">
                {title(x)}
              </Link>
              <div className="flex flex-wrap gap-2">
                <StatusChip state={x.state} label={t(`taskState.${x.state}`)} />
                <RiskChip level={x.riskLevel} label={t(`risk.${x.riskLevel}`)} />
                {x.blocked && <span className="rounded-full bg-feedback-warning px-3 py-1 text-sm font-semibold text-feedback-warning-fg">{t('tasks.blocked')}</span>}
              </div>
              <p className="text-base text-text-muted">
                {x.overdue ? t('tasks.overdue', { date: fmt(x.dueAt) }) : t('tasks.due', { date: fmt(x.dueAt) })}
              </p>
              {x.state === 'CHANGES_REQUESTED' && x.lastReturnReason && (
                <p className="rounded-md bg-feedback-error p-2 text-base text-feedback-error-fg">{t('tasks.returnedShort', { reason: t(`reasons.${x.lastReturnReason.reasonCode}`) })}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </StateBoundary>
  );
}
