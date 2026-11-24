import { Button, PageHeader, RiskChip, StateBoundary, StatusChip } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { canSee, type Section } from '../../lib/nav.js';
import { useMe } from '../auth/useMe.js';
import { useDate, useLocalized, } from '../plans/format.js';
import { useWardName } from '../plans/api.js';
import { useTaskQueue, type Task, type TaskView } from './api.js';
import { TaskReview } from './TaskReview.js';

const VIEW: Record<'reviews' | 'validations' | 'tasks', TaskView> = { reviews: 'review_queue', validations: 'validation_queue', tasks: 'ward' };

function TaskQueue({ section }: { section: 'reviews' | 'validations' | 'tasks' }) {
  const { t } = useTranslation();
  const q = useTaskQueue(VIEW[section]);
  const date = useDate();
  const loc = useLocalized();
  const ward = useWardName();
  const items = q.data?.items ?? [];
  const messages = useStateMessages({ empty: { title: t(`review.queues.${section}.emptyTitle`), description: t(`review.queues.${section}.emptyDescription`) } });
  const row = (x: Task) => (
    <li key={x.id} aria-label={loc(x.title)} className="flex flex-col gap-2 rounded-lg border border-border-subtle p-4 shadow-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-text">{loc(x.title)}</h3>
        <span className="text-sm text-text-muted">{ward(x.wardId)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <StatusChip state={x.state} label={t(`taskState.${x.state}`)} />
        <RiskChip level={x.riskLevel} label={t(`risk.${x.riskLevel}`)} />
        {x.blocked && <span className="rounded-full bg-feedback-warning px-3 py-1 text-sm font-semibold text-feedback-warning-fg">{t('review.blockedShort')}</span>}
      </div>
      <p className="text-sm text-text-muted">
        {t('review.queues.line', { due: date(x.dueAt), owner: x.ownerUserId, count: x.rejectionCount })}
      </p>
      <div>
        <Button asChild variant={section === 'tasks' ? 'secondary' : 'primary'}>
          <Link to={`/${section}/${x.id}`}>{t(`review.queues.${section}.open`)}</Link>
        </Button>
      </div>
    </li>
  );
  return (
    <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
      <ul className="flex flex-col gap-3" aria-label={t(`review.queues.${section}.title`)}>{items.map(row)}</ul>
    </StateBoundary>
  );
}

function useGate(section: Section) {
  const me = useMe().data;
  const messages = useStateMessages();
  const { t } = useTranslation();
  if (!me) return { me: undefined, denied: null };
  if (canSee(me.activeRole, section)) return { me, denied: null };
  return {
    me,
    denied: <StateBoundary status="denied" messages={messages} deniedAction={<Button asChild variant="secondary"><Link to="/">{t('section.backHome')}</Link></Button>} />,
  };
}

/** `/reviews`, `/validations`, `/tasks`: the supervisor's review queue, the validation queue (IPC officer, DQM), the ward's tasks. */
export function TaskQueueRoute({ section }: { section: 'reviews' | 'validations' | 'tasks' }) {
  const { t } = useTranslation();
  const { me, denied } = useGate(section);
  if (!me) return null;
  return (
    <>
      <PageHeader title={t(`review.queues.${section}.title`)} description={t(`review.queues.${section}.description`)} />
      {denied ?? <TaskQueue section={section} />}
    </>
  );
}

/** `/reviews/:taskId` (and the same under validations and tasks): one task to review or manage. */
export function TaskReviewRoute({ section }: { section: 'reviews' | 'validations' | 'tasks' }) {
  const { t } = useTranslation();
  const { taskId = '' } = useParams();
  const { me, denied } = useGate(section);
  if (!me) return null;
  return (
    <>
      <PageHeader
        title={t('review.title')}
        back={<Link to={`/${section}`} className="inline-flex min-h-touch items-center font-semibold text-action-primary underline">{t(`review.queues.${section}.back`)}</Link>}
      />
      {denied ?? <TaskReview taskId={taskId} role={me.activeRole} />}
    </>
  );
}
