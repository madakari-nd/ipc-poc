import { Button, PageHeader, Select, StateBoundary } from '@ipc/design-system';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMe } from '../auth/useMe.js';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { canSee } from '../../lib/nav.js';
import { useDate } from '../plans/format.js';
import { useOversightSummary } from './api.js';
import { DataQualityList } from './DataQualityList.js';
import { KpiTiles } from './KpiTiles.js';
import { ScoreTrend } from './ScoreTrend.js';
import { WardsTable } from './WardsTable.js';

const STATE = 'state';

/**
 * US8 oversight (T118): KPI tiles, ward table, score trend and data-quality exceptions. The
 * district/state switch only offers what the viewer's server-derived scope covers: the state
 * administrator sees the state and each district, a district quality manager only their own.
 */
export function OversightRoute() {
  const { t } = useTranslation();
  const me = useMe().data;
  const date = useDate();
  const [choice, setChoice] = useState<string | undefined>();
  const base = useOversightSummary();
  const isState = base.data?.scope.level === 'state';
  const districts = (base.data?.byDistrict ?? []).map((d) => d.districtCode);
  const view = choice && districts.includes(choice) ? choice : isState || districts.length !== 1 ? STATE : districts[0]!;
  const narrowed = useOversightSummary(view === STATE || !isState ? undefined : view);
  const q = view === STATE || !isState ? base : narrowed;
  const messages = useStateMessages();
  const allowed = !!me && (canSee(me.activeRole, 'oversight') || me.activeRole === 'IPC_OFFICER');
  const home = (
    <Button asChild variant="secondary">
      <Link to="/">{t('section.backHome')}</Link>
    </Button>
  );
  if (!me) return null;
  const s = q.data;
  const facilityIds = s && view !== STATE ? new Set(s.byFacility.map((f) => f.facilityId)) : undefined;
  const options = [
    ...(isState ? [{ value: STATE, label: t('oversight.switch.state') }] : []),
    ...districts.map((d) => ({ value: d, label: t('oversight.switch.district', { code: d }) })),
  ];

  return (
    <>
      <PageHeader title={t('oversight.title')} description={t('oversight.intro')} />
      <StateBoundary status={allowed ? boundaryStatus(q) : 'denied'} messages={messages} onRetry={() => void q.refetch()} deniedAction={home}>
        {s && (
          <div className="flex flex-col gap-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-[240px]">
                <Select label={t('oversight.switch.label')} value={view} onValueChange={setChoice} options={options} disabled={options.length < 2} />
              </div>
              <p className="text-sm text-text-muted">{t('oversight.asOf', { date: date(s.programmeAt) })}</p>
            </div>
            <section aria-labelledby="oversight-kpi" className="flex flex-col gap-3">
              <h2 id="oversight-kpi" className="text-xl font-semibold text-text">
                {view === STATE ? t('oversight.kpi.titleState') : t('oversight.kpi.titleDistrict', { code: view })}
              </h2>
              <KpiTiles counts={s.totals} />
            </section>
            <ScoreTrend trend={s.trend ?? []} />
            <WardsTable districtCode={isState && view !== STATE ? view : undefined} facilities={s.byFacility} />
            <DataQualityList facilityIds={facilityIds} />
          </div>
        )}
      </StateBoundary>
    </>
  );
}
