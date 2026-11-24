import { useTranslation } from 'react-i18next';
import type { OversightCounts } from './api.js';

/** FR-025 headline numbers for the selected district or the state. */
export function KpiTiles({ counts }: { counts: OversightCounts }) {
  const { t, i18n } = useTranslation();
  const pct = new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 0 }).format(counts.completionRate);
  const num = (n: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(n);
  const tiles: { key: string; value: string; note?: string; alert?: boolean }[] = [
    { key: 'completion', value: pct, note: t('oversight.kpi.completionNote', { assessed: counts.wardsAssessed, wards: counts.wards }) },
    { key: 'openCritical', value: num(counts.openCriticalTasks) },
    { key: 'overdueCritical', value: num(counts.overdueCriticalTasks), alert: counts.overdueCriticalTasks > 0 },
    { key: 'repeatedFailures', value: num(counts.repeatedFailures), alert: counts.repeatedFailures > 0 },
    { key: 'dataQuality', value: num(counts.dataQualityExceptions), alert: counts.dataQualityExceptions > 0 },
    { key: 'averageScore', value: counts.averageScore === undefined ? '—' : num(counts.averageScore) },
  ];
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('oversight.kpi.label')}>
      {tiles.map((x) => (
        <div
          key={x.key}
          data-kpi={x.key}
          className={`flex flex-col gap-1 rounded-lg border p-4 shadow-1 ${x.alert ? 'border-feedback-warning-fg bg-feedback-warning' : 'border-border-subtle bg-surface'}`}
        >
          <dt className={`text-sm font-semibold ${x.alert ? 'text-feedback-warning-fg' : 'text-text-muted'}`}>{t(`oversight.kpi.${x.key}`)}</dt>
          <dd className={`text-3xl font-semibold ${x.alert ? 'text-feedback-warning-fg' : 'text-text'}`}>{x.value}</dd>
          {x.note && <dd className={`text-sm ${x.alert ? 'text-feedback-warning-fg' : 'text-text-muted'}`}>{x.note}</dd>}
        </div>
      ))}
    </dl>
  );
}
