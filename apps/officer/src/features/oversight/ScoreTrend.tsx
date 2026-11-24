import { useTranslation } from 'react-i18next';
import type { OversightSummary } from './api.js';

/** Average score per cycle as labelled bars, backed by a table for assistive tech. */
export function ScoreTrend({ trend }: { trend: NonNullable<OversightSummary['trend']> }) {
  const { t, i18n } = useTranslation();
  const num = (n: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(n);
  const max = Math.max(1, ...trend.map((p) => p.averageScore));
  return (
    <section aria-labelledby="oversight-trend" className="flex flex-col gap-3">
      <h2 id="oversight-trend" className="text-xl font-semibold text-text">{t('oversight.trend.title')}</h2>
      {trend.length === 0 ? (
        <p className="text-text-muted">{t('oversight.trend.empty')}</p>
      ) : (
        <table className="w-full max-w-xl border-collapse text-left">
          <caption className="sr-only">{t('oversight.trend.title')}</caption>
          <thead>
            <tr>
              <th scope="col" className="pb-2 text-sm font-semibold text-text">{t('oversight.trend.cycle')}</th>
              <th scope="col" className="pb-2 text-sm font-semibold text-text">{t('oversight.trend.average')}</th>
            </tr>
          </thead>
          <tbody>
            {trend.map((p) => (
              <tr key={p.cycleCode}>
                <th scope="row" className="w-28 py-1 pr-3 font-normal text-text">{p.cycleCode}</th>
                <td className="py-1">
                  <div className="flex items-center gap-3">
                    <span aria-hidden="true" className="inline-block h-4 rounded-sm bg-focus" style={{ width: `${Math.max(2, (p.averageScore / max) * 240)}px` }} />
                    <span className="text-text">{num(p.averageScore)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
