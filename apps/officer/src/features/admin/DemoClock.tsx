import { Button, StateBoundary, useToast } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router-dom';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useMe } from '../auth/useMe.js';
import { KEYS, useAdminWrite, useDemoClock, type DemoClock } from './api.js';
import { Panel, WriteError, useFormatDate } from './common.js';

/**
 * FR-038: a visible banner on every screen while programme time is not real time. Rendered by a
 * layout route around the signed-in pages; it asks only when the session is in demo mode.
 */
export function DemoClockBanner() {
  const { t } = useTranslation();
  const fmt = useFormatDate();
  const me = useMe().data;
  const clock = useDemoClock(!!me?.demoMode);
  if (!clock.data || clock.data.isRealTime) return null;
  return (
    <div role="status" data-testid="demo-clock-banner" className="mb-4 flex items-center gap-2 rounded-md border border-feedback-warning-fg bg-feedback-warning p-3 text-feedback-warning-fg">
      <span aria-hidden="true">⏱</span>
      <span className="font-semibold">{t('demoClock.banner', { when: fmt(clock.data.programmeNow) })}</span>
    </div>
  );
}

export function WithDemoClockBanner() {
  return (
    <>
      <DemoClockBanner />
      <Outlet />
    </>
  );
}

const STEPS = ['PT48H', 'P7D', 'P30D'] as const;

/** Demo clock (FR-038): shift programme time forward or back to real time; ELEVATE dates never move. */
export function DemoClockPanel() {
  const { t } = useTranslation();
  const fmt = useFormatDate();
  const toast = useToast();
  const q = useDemoClock();
  const messages = useStateMessages();
  const shift = useAdminWrite<{ advanceBy: string; v: number }, DemoClock>(
    ({ advanceBy, v }) => ({ path: '/ipc/v1/demo/clock', method: 'PUT', body: { advanceBy, reason: 'demo' }, ifMatch: v }),
    [KEYS.clock],
  );
  const reset = useAdminWrite<void, DemoClock>(() => ({ path: '/ipc/v1/demo/clock/reset', method: 'POST', body: {} }), [KEYS.clock]);
  const c = q.data;
  return (
    <Panel title={t('demoClock.title')}>
      <StateBoundary status={boundaryStatus(q)} messages={messages} onRetry={() => void q.refetch()}>
        {c && (
          <div className="flex flex-col gap-3">
            <dl className="grid gap-2 md:grid-cols-2">
              <div><dt className="text-sm text-text-muted">{t('demoClock.realNow')}</dt><dd className="text-lg font-semibold">{fmt(c.realNow)}</dd></div>
              <div><dt className="text-sm text-text-muted">{t('demoClock.programmeNow')}</dt><dd className="text-lg font-semibold" data-testid="programme-now">{fmt(c.programmeNow)}</dd></div>
            </dl>
            <p className="text-base">{t(c.isRealTime ? 'demoClock.isReal' : 'demoClock.isShifted')}</p>
            {!c.demoMode ? (
              <p role="note" className="rounded-md bg-feedback-warning p-3 text-feedback-warning-fg">{t('demoClock.disabled')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {STEPS.map((s) => (
                  <Button key={s} variant="secondary" busy={shift.isPending} onClick={() => shift.mutate({ advanceBy: s, v: c.v }, { onSuccess: () => toast.show({ tone: 'info', title: t('demoClock.shifted') }) })}>
                    {t(`demoClock.steps.${s}`)}
                  </Button>
                ))}
                <Button variant="ghost" disabled={c.isRealTime} busy={reset.isPending} onClick={() => reset.mutate(undefined, { onSuccess: () => toast.show({ tone: 'success', title: t('demoClock.wasReset') }) })}>
                  {t('demoClock.reset')}
                </Button>
              </div>
            )}
            <p className="text-sm text-text-muted">{t('demoClock.elevateNote')}</p>
          </div>
        )}
      </StateBoundary>
      <WriteError error={shift.error ?? reset.error} />
    </Panel>
  );
}
