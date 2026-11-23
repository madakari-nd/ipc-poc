import { Button, PageHeader, RiskChip, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMe } from '../auth/useMe.js';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { canSee } from '../../lib/nav.js';
import { usePlans, useWardName, type Plan, type RiskLevel } from './api.js';
import { useDate } from './format.js';

const RISKS: RiskLevel[] = ['critical', 'high', 'normal'];

function PlanCard({ plan, action }: { plan: Plan; action: string }) {
  const { t } = useTranslation();
  const ward = useWardName();
  const date = useDate();
  const counts = plan.taskCounts ?? {};
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border-subtle p-4 shadow-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-text">{ward(plan.wardId)}</h3>
        <span className="text-sm text-text-muted">
          {plan.status === 'draft' ? t('plans.queue.drafted', { date: date(plan.draftCreatedAt ?? plan.createdAt) }) : t('plans.revisionN', { n: plan.revision })}
        </span>
      </div>
      <ul className="flex flex-wrap gap-2" aria-label={t('plans.queue.counts')}>
        {RISKS.filter((r) => (counts[r] ?? 0) > 0).map((r) => (
          <li key={r}>
            <RiskChip level={r} label={t('plans.queue.riskCount', { count: counts[r], risk: t(`risk.${r}`) })} />
          </li>
        ))}
        {(plan.carriedOverTaskIds ?? []).length > 0 && (
          <li className="text-sm text-text-muted">{t('plans.queue.carried', { count: plan.carriedOverTaskIds!.length })}</li>
        )}
      </ul>
      <div>
        <Button asChild variant={plan.status === 'draft' ? 'primary' : 'secondary'}>
          <Link to={`/plans/${plan.id}`}>{action}</Link>
        </Button>
      </div>
    </li>
  );
}

/** Draft queue (T088): drafts made from completed assessments; empty = "No actions needed". */
export function DraftQueue() {
  const { t } = useTranslation();
  const q = usePlans('draft');
  const items = q.data?.items ?? [];
  const messages = useStateMessages({ empty: { title: t('plans.noActions.title'), description: t('plans.noActions.description') } });
  return (
    <section aria-labelledby="draft-queue" className="flex flex-col gap-3">
      <h2 id="draft-queue" className="text-xl font-semibold text-text">{t('plans.queue.title')}</h2>
      <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <ul className="flex flex-col gap-3" aria-label={t('plans.queue.title')}>
          {items.map((p) => <PlanCard key={p.id} plan={p} action={t('plans.queue.review')} />)}
        </ul>
      </StateBoundary>
    </section>
  );
}

function ActivePlans() {
  const { t } = useTranslation();
  const q = usePlans('active');
  const items = q.data?.items ?? [];
  const messages = useStateMessages({ empty: { title: t('plans.active.emptyTitle'), description: t('plans.active.emptyDescription') } });
  return (
    <section aria-labelledby="active-plans" className="flex flex-col gap-3">
      <h2 id="active-plans" className="text-xl font-semibold text-text">{t('plans.active.title')}</h2>
      <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <ul className="flex flex-col gap-3" aria-label={t('plans.active.title')}>
          {items.map((p) => <PlanCard key={p.id} plan={p} action={t('plans.active.open')} />)}
        </ul>
      </StateBoundary>
    </section>
  );
}

/** `/plans`: the officer's draft queue and the active plans of their facility. */
export function PlansRoute() {
  const { t } = useTranslation();
  const me = useMe().data;
  const messages = useStateMessages();
  if (!me) return null;
  const header = <PageHeader title={t('nav.plans')} description={t('plans.intro')} />;
  if (!canSee(me.activeRole, 'plans')) {
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
        {me.activeRole === 'IPC_OFFICER' && <DraftQueue />}
        <ActivePlans />
      </div>
    </>
  );
}
