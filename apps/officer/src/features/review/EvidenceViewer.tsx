import { Button, ConfirmWithReason, useToast } from '@ipc/design-system';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useReasonLabels } from './labels.js';
import { downloadLink, reviewErrorKey, useDeletePatientData, useEvidence } from './api.js';

/**
 * One proof item: capture time, GPS or "GPS unavailable", fingerprint, and the file itself opened
 * through a short-lived signed URL fetched on demand (FR-029). The reviewer can permanently delete
 * media that shows a patient (FR-032; content removed, metadata and audit kept).
 */
export function EvidenceCard({ id, index, taskId, canDelete }: { id: string; index: number; taskId: string; canDelete: boolean }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useEvidence(id);
  const del = useDeletePatientData(taskId);
  const labels = useReasonLabels();
  const [url, setUrl] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ev = q.data;
  const fmt = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const num = (n: number, d: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: d }).format(n);

  const open = async () => {
    setOpening(true);
    try {
      setUrl((await downloadLink(id)).url);
    } catch (e) {
      toast.show({ tone: 'error', title: t(reviewErrorKey(e)) });
    } finally {
      setOpening(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border-subtle p-3" aria-label={t('review.evidence.item', { n: index + 1 })}>
      <h4 className="font-semibold text-text">{t('review.evidence.item', { n: index + 1 })}</h4>
      {q.isError && <p className="text-text-muted">{t('review.evidence.unavailable')}</p>}
      {ev && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-semibold">{t('review.evidence.captured')}</dt>
            <dd>{fmt(ev.capturedAt)}</dd>
            <dt className="font-semibold">{t('review.evidence.location')}</dt>
            <dd>{ev.gps ? t('review.evidence.gps', { lat: num(ev.gps.lat, 5), lng: num(ev.gps.lng, 5), accuracy: num(ev.gps.accuracyM, 0) }) : t('review.evidence.gpsUnavailable')}</dd>
            <dt className="font-semibold">{t('review.evidence.fingerprint')}</dt>
            <dd className="break-all font-mono">{ev.sha256}</dd>
          </dl>
          {ev.state === 'deleted_patient_data' ? (
            <p className="rounded-md bg-feedback-warning p-2 text-feedback-warning-fg">{t('review.evidence.deleted')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!url && <Button variant="secondary" onClick={() => void open()} busy={opening}>{t('review.evidence.open')}</Button>}
              {canDelete && <Button variant="danger" onClick={() => setConfirm(true)}>{t('review.evidence.delete')}</Button>}
            </div>
          )}
          {url && ev.state !== 'deleted_patient_data' && (
            ev.mime === 'application/pdf'
              ? <a href={url} target="_blank" rel="noreferrer" className="font-semibold text-action-primary underline">{t('review.evidence.openPdf')}</a>
              : <img src={url} alt={t('review.evidence.alt', { n: index + 1 })} className="max-h-[360px] w-auto rounded-md object-contain" />
          )}
          <ConfirmWithReason
            open={confirm}
            onOpenChange={setConfirm}
            title={t('review.evidence.deleteTitle')}
            description={t('review.evidence.deleteDescription')}
            reasons={[]}
            labels={{ ...labels, confirm: t('review.evidence.deleteConfirm') }}
            busy={del.isPending}
            onConfirm={async ({ reasonText }) => {
              try {
                await del.mutateAsync({ evidence: ev, reasonText });
                setConfirm(false);
                setUrl(null);
                toast.show({ tone: 'success', title: t('review.evidence.deletedToast') });
              } catch (e) {
                toast.show({ tone: 'error', title: t(reviewErrorKey(e)) });
              }
            }}
          />
        </>
      )}
    </li>
  );
}
