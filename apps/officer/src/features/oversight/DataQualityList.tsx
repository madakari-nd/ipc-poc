import { Select, StateBoundary } from '@ipc/design-system';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useDate } from '../plans/format.js';
import { DQ_KINDS, useDataQuality, type DataQualityException, type DataQualityExceptionKind } from './api.js';

const ALL = 'all';

function Item({ e }: { e: DataQualityException }) {
  const { t, i18n } = useTranslation();
  const date = useDate();
  const num = (n: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 }).format(n);
  const m = e.metric ?? {};
  const detail = [
    m.distanceM !== undefined && t('oversight.dq.metric.distance', { value: num(m.distanceM) }),
    m.skewSec !== undefined && t('oversight.dq.metric.skew', { value: num(Math.round(Math.abs(m.skewSec) / 60)) }),
    m.uploadDelayHours !== undefined && t('oversight.dq.metric.delay', { value: num(Math.round(m.uploadDelayHours / 24)) }),
    m.oldestPendingHours !== undefined && t('oversight.dq.metric.pending', { value: num(m.oldestPendingHours), count: m.pendingCount ?? 0 }),
    m.daysSinceStart !== undefined && t('oversight.dq.metric.days', { value: num(m.daysSinceStart) }),
    e.relatedEvidenceIds?.length ? t('oversight.dq.metric.related', { count: e.relatedEvidenceIds.length }) : false,
  ].filter(Boolean);
  const place = [e.facilityName, e.wardName].filter(Boolean).join(' · ');
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border-subtle p-4" aria-label={`${t(`oversight.dq.kind.${e.kind}`)}: ${place}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-text">{t(`oversight.dq.kind.${e.kind}`)}</h3>
        <span className="text-sm text-text-muted">{date(e.detectedAt)}</span>
      </div>
      <p className="text-text">{place || t('oversight.dq.unknownPlace')}</p>
      {e.userId && <p className="text-sm text-text-muted">{t(e.kind === 'STALE_DEVICE_QUEUE' ? 'oversight.dq.deviceUser' : 'oversight.dq.uploader', { name: e.userName ?? e.userId })}</p>}
      {detail.length > 0 && <p className="text-sm text-text-muted">{detail.join(' · ')}</p>}
    </li>
  );
}

/** FR-026 data-quality exceptions, limited to the viewer's scope (and the selected district). */
export function DataQualityList({ facilityIds }: { facilityIds?: Set<string> }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState(ALL);
  const q = useDataQuality(kind === ALL ? undefined : (kind as DataQualityExceptionKind));
  const items = (q.data ?? []).filter((e) => !facilityIds || facilityIds.has(e.facilityId));
  const messages = useStateMessages({ empty: { title: t('oversight.dq.empty.title'), description: t('oversight.dq.empty.description') } });
  return (
    <section aria-labelledby="oversight-dq" className="flex flex-col gap-3">
      <h2 id="oversight-dq" className="text-xl font-semibold text-text">{t('oversight.dq.title')}</h2>
      <div className="md:max-w-sm">
        <Select
          label={t('oversight.dq.filterKind')}
          value={kind}
          onValueChange={setKind}
          options={[{ value: ALL, label: t('oversight.dq.allKinds') }, ...DQ_KINDS.map((k) => ({ value: k, label: t(`oversight.dq.kind.${k}`) }))]}
        />
      </div>
      <StateBoundary status={boundaryStatus(q, items.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <ul className="flex flex-col gap-3" aria-label={t('oversight.dq.title')}>
          {items.map((e) => <Item key={e.id} e={e} />)}
        </ul>
      </StateBoundary>
    </section>
  );
}
