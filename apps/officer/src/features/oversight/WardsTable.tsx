import { DataTable, Select, StateBoundary, type Column } from '@ipc/design-system';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { boundaryStatus, useStateMessages } from '../../lib/boundary.js';
import { useOversightWards, type OversightSummary, type OversightWardRow } from './api.js';

const ALL = 'all';
const STATUSES: OversightWardRow['assessmentStatus'][] = ['not_started', 'submitted', 'completed', 'held'];

/** Ward table with hospital and assessment-status filters (FR-025). */
export function WardsTable({ districtCode, facilities }: { districtCode?: string; facilities: OversightSummary['byFacility'] }) {
  const { t, i18n } = useTranslation();
  const [facilityId, setFacilityId] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const facility = facilities.some((f) => f.facilityId === facilityId) ? facilityId : ALL;
  const q = useOversightWards(districtCode, facility === ALL ? undefined : facility);
  const rows = (q.data ?? []).filter((r) => status === ALL || r.assessmentStatus === status);
  const num = (n?: number) => (n === undefined ? '—' : new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(n));
  const messages = useStateMessages({ empty: { title: t('oversight.wards.empty.title'), description: t('oversight.wards.empty.description') } });

  const columns: Column<OversightWardRow>[] = [
    { key: 'ward', header: t('oversight.wards.ward'), cell: (r) => <span className="font-semibold">{r.wardName}</span> },
    { key: 'facility', header: t('oversight.wards.facility'), cell: (r) => r.facilityName },
    { key: 'district', header: t('oversight.wards.district'), cell: (r) => r.districtCode },
    { key: 'status', header: t('oversight.wards.status'), cell: (r) => t(`oversight.status.${r.assessmentStatus}`) },
    { key: 'score', header: t('oversight.wards.score'), cell: (r) => num(r.latestScore), className: 'text-right' },
    { key: 'open', header: t('oversight.wards.openCritical'), cell: (r) => r.openCriticalTasks, className: 'text-right' },
    { key: 'overdue', header: t('oversight.wards.overdueCritical'), cell: (r) => r.overdueCriticalTasks, className: 'text-right' },
    { key: 'repeated', header: t('oversight.wards.repeatedFailures'), cell: (r) => r.repeatedFailures, className: 'text-right' },
    { key: 'dq', header: t('oversight.wards.dataQuality'), cell: (r) => r.dataQualityExceptions ?? 0, className: 'text-right' },
  ];

  return (
    <section aria-labelledby="oversight-wards" className="flex flex-col gap-3">
      <h2 id="oversight-wards" className="text-xl font-semibold text-text">{t('oversight.wards.title')}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:max-w-2xl">
        <Select
          label={t('oversight.wards.filterFacility')}
          value={facility}
          onValueChange={setFacilityId}
          options={[{ value: ALL, label: t('oversight.wards.allFacilities') }, ...facilities.map((f) => ({ value: f.facilityId, label: f.name }))]}
        />
        <Select
          label={t('oversight.wards.filterStatus')}
          value={status}
          onValueChange={setStatus}
          options={[{ value: ALL, label: t('oversight.wards.allStatuses') }, ...STATUSES.map((s) => ({ value: s, label: t(`oversight.status.${s}`) }))]}
        />
      </div>
      <StateBoundary status={boundaryStatus(q, rows.length === 0)} messages={messages} onRetry={() => void q.refetch()}>
        <DataTable caption={t('oversight.wards.title')} hideCaption columns={columns} rows={rows} getRowId={(r) => r.wardId} />
      </StateBoundary>
    </section>
  );
}
