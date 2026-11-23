import { Button, DataTable, StateBoundary, useToast, type Column } from '@ipc/design-system';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError, NetworkError } from '../../lib/api.js';
import { errorStatus, useStateMessages } from '../../lib/boundary.js';
import { useSignedIn } from '../session/SessionProvider.js';
import { fetchAssignedWards, startAssessment, type WardRow } from './api.js';
import { newDraft } from './draft.js';
import { addDownload, listDownloads, loadDraft, saveDraft } from './store.js';

export const WARDS_KEY = ['assessment', 'wards'] as const;
export const DOWNLOADS_KEY = ['assessment', 'downloads'] as const;

interface Row extends WardRow {
  downloaded: boolean;
  localState?: 'editing' | 'queued' | 'read_only';
}

/** US2: wards to assess in the open cycle; download one while online, then work offline. */
export function WardList() {
  const { t } = useTranslation();
  const { db, key, offline } = useSignedIn();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const wards = useQuery({ queryKey: WARDS_KEY, queryFn: fetchAssignedWards, retry: false });
  const downloads = useQuery({
    queryKey: DOWNLOADS_KEY,
    queryFn: async () => {
      const list = await listDownloads(db, key);
      return Promise.all(list.map(async (d) => ({ ...d, state: (await loadDraft(db, key, d.assessmentId))?.state })));
    },
  });
  const messages = useStateMessages({ empty: { title: t('assessment.list.empty.title'), description: t('assessment.list.empty.description') } });

  // Online rows merged with the device's downloads; offline, the downloads alone.
  const local = new Map((downloads.data ?? []).map((d) => [d.wardId, d]));
  const rows: Row[] = wards.data
    ? wards.data.map((w) => {
        const d = local.get(w.wardId);
        return { ...w, downloaded: !!d && (!w.assessmentId || d.assessmentId === w.assessmentId), localState: d?.state, ...(d ? { assessmentId: d.assessmentId } : {}) };
      })
    : (downloads.data ?? []).map((d) => ({
        wardId: d.wardId,
        wardName: d.wardName,
        wardType: '',
        facilityName: d.facilityName,
        cycleId: d.cycleId,
        cycleCode: '',
        assessmentId: d.assessmentId,
        downloaded: true,
        localState: d.state,
      }));

  const download = async (w: Row) => {
    setBusy(w.wardId);
    try {
      const s = await startAssessment(w.wardId, w.cycleId);
      const existing = await loadDraft(db, key, s.assessmentId);
      if (!existing) await saveDraft(db, key, newDraft(s, w.wardName));
      await addDownload(db, key, { assessmentId: s.assessmentId, wardId: w.wardId, wardName: w.wardName, facilityName: w.facilityName, cycleId: w.cycleId });
      await qc.invalidateQueries({ queryKey: DOWNLOADS_KEY });
      toast.show({ tone: 'success', title: t('assessment.list.downloaded', { ward: w.wardName }) });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : e instanceof NetworkError ? 'NETWORK' : 'CLIENT_ERROR';
      toast.show({ tone: 'error', title: t('assessment.list.downloadFailed'), description: t('assessment.list.problemCode', { code }) });
    } finally {
      setBusy(null);
    }
  };

  const statusText = (r: Row) => {
    if (r.localState) return t(`assessment.list.local.${r.localState}`);
    if (r.status) return t(`assessment.list.server.${r.status}`);
    return t('assessment.list.notStarted');
  };

  const columns: Column<Row>[] = [
    {
      key: 'ward',
      header: t('assessment.list.columns.ward'),
      cell: (r) => (
        <div className="flex flex-col">
          <span className="font-semibold">{r.wardName}</span>
          <span className="text-sm text-text-muted">{r.facilityName}</span>
        </div>
      ),
    },
    { key: 'status', header: t('assessment.list.columns.status'), cell: (r) => <span className="text-sm">{statusText(r)}</span> },
    {
      key: 'action',
      header: t('assessment.list.columns.action'),
      cell: (r) =>
        r.downloaded && r.assessmentId ? (
          <Button asChild variant="secondary">
            <Link to={`/assessments/${r.assessmentId}`} aria-label={t('assessment.list.openWard', { ward: r.wardName })}>
              {t('assessment.list.open')}
            </Link>
          </Button>
        ) : (
          // Not on this phone: download it (a sent assessment can be followed by a repeat one).
          <Button busy={busy === r.wardId} disabled={offline || busy !== null} onClick={() => void download(r)} aria-label={t('assessment.list.downloadWard', { ward: r.wardName })}>
            {t('assessment.list.download')}
          </Button>
        ),
    },
  ];

  const status = (() => {
    if (wards.isPending && downloads.isPending) return 'loading' as const;
    if (wards.isError && rows.length === 0) return errorStatus(wards.error);
    if (!wards.isPending && rows.length === 0) return 'empty' as const;
    return rows.length ? ('ready' as const) : ('loading' as const);
  })();

  return (
    <StateBoundary status={status} messages={messages} onRetry={() => void wards.refetch()} emptyAction={<Link to="/">{t('nav.home')}</Link>}>
      {wards.isError && (
        <p role="status" className="mb-3 rounded-md bg-feedback-offline p-3 text-feedback-offline-fg">
          {t('assessment.list.offlineOnlyDownloads')}
        </p>
      )}
      <DataTable caption={t('assessment.list.title')} hideCaption columns={columns} rows={rows} getRowId={(r) => r.wardId} />
    </StateBoundary>
  );
}
