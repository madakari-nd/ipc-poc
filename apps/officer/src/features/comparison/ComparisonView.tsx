import { Button, DataTable, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useDate, useLocalized } from '../plans/format.js';
import { useWardName } from '../plans/api.js';
import { useComparison, useTrend, type Comparison } from './api.js';
import { TrendChart } from './TrendChart.js';

type Section = Comparison['sections'][number];
type Side = Comparison['current'];

/** "+10", "−5", "0": the sign is text, never colour alone. */
export function formatChange(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return '0';
}

function SideCard({ title, side, testId }: { title: string; side: Side; testId: string }) {
  const { t } = useTranslation();
  const date = useDate();
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border-subtle p-4" data-testid={testId}>
      <h3 className="text-lg font-semibold text-text">{title}</h3>
      <p className="text-3xl font-bold text-text">{side.total}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm text-text">
        <dt className="text-text-muted">{t('comparison.version')}</dt>
        <dd>{t('comparison.versionN', { n: side.checklistVersion })}</dd>
        <dt className="text-text-muted">{t('comparison.assessor')}</dt>
        <dd>{t(`comparison.assessorType.${side.assessorType}`)}</dd>
        <dt className="text-text-muted">{t('comparison.completed')}</dt>
        <dd>{date(side.completedAt)}</dd>
      </dl>
    </div>
  );
}

/** Per-section deltas and the "Not comparable (version change)" list (US7, FR-024). */
export function ComparisonView({ c }: { c: Comparison }) {
  const { t } = useTranslation();
  const localized = useLocalized();
  if (!c.baselineAssessmentId) {
    return <p className="rounded-md border border-border-subtle p-4 text-text">{t('comparison.noBaseline')}</p>;
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-3">
        <SideCard title={t('comparison.baseline')} side={c.baseline} testId="side-baseline" />
        <SideCard title={t('comparison.repeat')} side={c.current} testId="side-current" />
        <div className="flex flex-col gap-1 rounded-lg border border-border-subtle p-4" data-testid="total-change">
          <h3 className="text-lg font-semibold text-text">{t('comparison.totalChange')}</h3>
          <p className="text-3xl font-bold text-text">{formatChange(c.totalChange ?? 0)}</p>
          {c.current.checklistVersionId !== c.baseline.checklistVersionId && <p className="text-sm text-text-muted">{t('comparison.likeForLike')}</p>}
        </div>
      </div>
      <DataTable<Section>
        caption={t('comparison.sections')}
        rows={c.sections}
        getRowId={(s) => s.sectionKey}
        columns={[
          { key: 'section', header: t('comparison.section'), cell: (s) => (s.title ? localized(s.title as { en: string }) : s.sectionKey) },
          { key: 'baseline', header: t('comparison.baseline'), cell: (s) => s.baseline },
          { key: 'current', header: t('comparison.repeat'), cell: (s) => s.current },
          { key: 'change', header: t('comparison.change'), cell: (s) => <span data-testid={`change-${s.sectionKey}`}>{formatChange(s.change)}</span> },
          { key: 'n', header: t('comparison.compared'), cell: (s) => s.comparedQuestions },
        ]}
      />
      <section aria-labelledby="not-comparable" className="flex flex-col gap-2">
        <h2 id="not-comparable" className="text-xl font-semibold text-text">{t('comparison.notComparable.title')}</h2>
        {c.notComparable.length === 0 ? (
          <p className="text-text-muted">{t('comparison.notComparable.none')}</p>
        ) : (
          <ul className="list-disc pl-6 text-text" aria-labelledby="not-comparable">
            {c.notComparable.map((q) => (
              <li key={q.questionKey}>
                <span className="font-semibold">{q.questionKey}</span> — {t(`comparison.notComparable.${q.reason}`)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** `/assessments/:assessmentId/comparison`: comparison with the baseline and the ward trend. */
export function ComparisonRoute() {
  const { t } = useTranslation();
  const { assessmentId = '' } = useParams();
  const q = useComparison(assessmentId);
  const trend = useTrend(q.data?.wardId);
  const ward = useWardName();
  const messages = useStateMessages();
  const back = (
    <Button asChild variant="secondary">
      <Link to="/assessments">{t('comparison.back')}</Link>
    </Button>
  );
  return (
    <>
      <PageHeader title={t('comparison.title')} description={q.data ? ward(q.data.wardId) : undefined} />
      <StateBoundary status={boundaryStatus(q)} messages={messages} onRetry={() => void q.refetch()} deniedAction={back}>
        {q.data && (
          <div className="flex flex-col gap-8">
            <ComparisonView c={q.data} />
            {trend.data && <TrendChart trend={trend.data} />}
            <div>{back}</div>
          </div>
        )}
      </StateBoundary>
    </>
  );
}
