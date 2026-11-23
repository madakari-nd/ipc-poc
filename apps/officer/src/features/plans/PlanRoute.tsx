import { Button, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useMe } from '../auth/useMe.js';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { canSee } from '../../lib/nav.js';
import { NotFoundRoute } from '../../routes/NotFoundRoute.js';
import { ActivePlan } from './ActivePlan.js';
import { CarriedOverTasks } from './CarriedOverTasks.js';
import { PlanEditor } from './PlanEditor.js';
import { usePlan, useWardName } from './api.js';

/** `/plans/:planId`: the draft editor for a draft, the plan with history for an approved plan. */
export function PlanRoute() {
  const { t } = useTranslation();
  const { planId = '' } = useParams();
  const me = useMe().data;
  const valid = /^[a-f0-9]{24}$/.test(planId);
  const q = usePlan(planId, valid);
  const ward = useWardName();
  const messages = useStateMessages();
  if (!me) return null;
  if (!valid) return <NotFoundRoute />;
  const back = <Button asChild variant="ghost"><Link to="/plans">{t('plans.back')}</Link></Button>;
  if (!canSee(me.activeRole, 'plans')) {
    return (
      <>
        <PageHeader title={t('nav.plans')} back={back} />
        <StateBoundary status="denied" messages={messages} deniedAction={back} />
      </>
    );
  }
  const plan = q.data;
  const officer = me.activeRole === 'IPC_OFFICER';
  return (
    <>
      <PageHeader
        title={plan ? (plan.status === 'draft' ? t('plans.draftTitle', { ward: ward(plan.wardId) }) : t('plans.planTitle', { ward: ward(plan.wardId) })) : t('nav.plans')}
        description={plan ? (plan.status === 'draft' ? t('plans.draftIntro') : t('plans.revisionN', { n: plan.revision })) : undefined}
        back={back}
      />
      <StateBoundary status={boundaryStatus(q)} messages={messages} onRetry={() => void q.refetch()} deniedAction={back}>
        {plan && plan.status === 'draft' && (
          <div className="flex flex-col gap-8">
            {officer ? <PlanEditor plan={plan} /> : <p className="text-base text-text-muted">{t('plans.readOnly')}</p>}
            <CarriedOverTasks tasks={plan.tasks ?? []} />
          </div>
        )}
        {plan && plan.status !== 'draft' && <ActivePlan plan={plan} canRevise={officer && plan.status === 'active'} />}
      </StateBoundary>
    </>
  );
}
