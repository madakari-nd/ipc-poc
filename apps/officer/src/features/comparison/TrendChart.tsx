import { DataTable } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Trend } from './api.js';

type Point = Trend['points'][number];

/**
 * Score trend of a ward across cycles (US7). The chart is decorative for screen readers; the same
 * numbers are in the table below it (Constitution VIII), so nothing depends on seeing the line.
 */
export function TrendChart({ trend }: { trend: Trend }) {
  const { t } = useTranslation();
  const data = trend.points.map((p) => ({ cycle: p.cycleCode, total: p.total }));
  return (
    <section aria-labelledby="trend-title" className="flex flex-col gap-3">
      <h2 id="trend-title" className="text-xl font-semibold text-text">{t('comparison.trend.title')}</h2>
      {trend.points.length === 0 ? (
        <p className="text-text-muted">{t('comparison.trend.empty')}</p>
      ) : (
        <>
          <div className="h-64 w-full" aria-hidden="true" data-testid="trend-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle, #d0d5dd)" />
                <XAxis dataKey="cycle" stroke="var(--text-muted, #475467)" />
                <YAxis allowDecimals={false} stroke="var(--text-muted, #475467)" />
                <Tooltip />
                <Line type="monotone" dataKey="total" name={t('comparison.trend.total')} stroke="var(--action-primary, #1d4ed8)" strokeWidth={3} dot={{ r: 5 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <DataTable<Point>
            caption={t('comparison.trend.table')}
            rows={trend.points}
            getRowId={(p) => p.assessmentId}
            columns={[
              { key: 'cycle', header: t('comparison.trend.cycle'), cell: (p) => p.cycleCode },
              { key: 'version', header: t('comparison.version'), cell: (p) => t('comparison.versionN', { n: p.checklistVersion }) },
              { key: 'assessor', header: t('comparison.assessor'), cell: (p) => (p.assessorType ? t(`comparison.assessorType.${p.assessorType}`) : '—') },
              { key: 'total', header: t('comparison.trend.total'), cell: (p) => p.total },
            ]}
          />
        </>
      )}
    </section>
  );
}
