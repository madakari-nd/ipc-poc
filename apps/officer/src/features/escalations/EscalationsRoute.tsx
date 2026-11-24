import { Button, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useMe } from '../auth/useMe.js';
import { useEscalations, useRunEscalationSweep } from './api.js';

/** Small pill with the semantic surface colour (rule code / vacant flag). */
function Pill({ label }: { label: string }) {
  return <span className="rounded-full border border-border-subtle bg-surface-muted px-2 py-0.5 text-sm font-semibold text-text">{label}</span>;
}

/**
 * `/escalations` (US5, T102): escalations within the caller's scope or targeted to them. Each row
 * shows the rule, the level it reached, the target role, when it was raised and the reason. The
 * task owner and history are unchanged (the escalation is a separate record). A state administrator
 * can run the sweep now in demo mode.
 */
export function EscalationsRoute() {
  const { t, i18n } = useTranslation();
  const me = useMe().data;
  const q = useEscalations();
  const sweep = useRunEscalationSweep();
  const items = q.data?.items ?? [];
  const messages = useStateMessages({ empty: { title: t('escalations.list.emptyTitle'), description: t('escalations.list.emptyDescription') } });
  const fmt = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  if (!me) return null;
  const canRunSweep = me.activeRole === 'STATE_ADMIN' && me.demoMode;

  return (
    <>
      <PageHeader title={t('nav.escalations')} description={t('escalations.intro')} />
      {canRunSweep && (
        <div className="mb-4 flex items-center gap-3">
          <Button variant="secondary" onClick={() => sweep.mutate()} disabled={sweep.isPending}>
            {sweep.isPending ? t('escalations.sweep.running') : t('escalations.sweep.runNow')}
          </Button>
          {sweep.data && <span className="text-sm text-text-muted">{t('escalations.sweep.result', { n: sweep.data.created.length })}</span>}
        </div>
      )}
      <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <ul className="flex flex-col gap-3" aria-label={t('nav.escalations')}>
          {items.map((e) => (
            <li key={e.id} className="flex flex-col gap-2 rounded-lg border border-border-subtle p-4 shadow-1">
              <div className="flex flex-wrap items-center gap-2">
                <Pill label={e.ruleCode} />
                <span className="text-sm text-text-muted">{t('escalations.list.level', { level: e.level })}</span>
                <span className="text-sm font-semibold text-text">{e.targetRole.replace(/_/g, ' ')}</span>
                {e.vacantTargetFlag && <Pill label={t('escalations.list.vacant')} />}
              </div>
              <div className="flex flex-col gap-1 text-base">
                {e.reason && <p className="text-text">{e.reason}</p>}
                <p className="text-sm text-text-muted">{t('escalations.list.raisedAt', { at: fmt(e.raisedAt) })}</p>
                <Link to={`/tasks/${e.taskId}`} className="inline-flex min-h-touch items-center font-semibold text-action-primary underline">
                  {t('escalations.list.openTask')}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </StateBoundary>
    </>
  );
}
