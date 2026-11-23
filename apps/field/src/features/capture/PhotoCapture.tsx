import { Button, StateBoundary } from '@ipc/design-system';
import { useEffect, useId, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useStateMessages } from '../../lib/boundary.js';
import { capturePhoto, type CaptureProblem, type CapturedPhoto, type PositionGetter } from './capture.js';

export interface PhotoCaptureProps {
  /** Called when the user accepts the photo; the caller queues it in the outbox. */
  onCapture: (photo: CapturedPhoto) => void;
  getPosition?: PositionGetter;
  now?: () => Date;
}

type Step = { kind: 'idle' } | { kind: 'working' } | { kind: 'error'; problem: CaptureProblem } | { kind: 'review'; photo: CapturedPhoto; previewUrl?: string };

/**
 * Camera capture (Constitution VII): records GPS (or the "GPS unavailable" flag), device time and a
 * SHA-256 computed on the device. Nothing is sent from here.
 */
export function PhotoCapture({ onCapture, getPosition, now }: PhotoCaptureProps) {
  const { t, i18n } = useTranslation();
  const inputId = useId();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const messages = useStateMessages({ loading: t('capture.working') });

  const previewUrl = step.kind === 'review' ? step.previewUrl : undefined;
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setStep({ kind: 'working' });
    const res = await capturePhoto(file, { getPosition, now });
    if (!res.ok) {
      setStep({ kind: 'error', problem: res.problem });
      return;
    }
    const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
    setStep({ kind: 'review', photo: res.photo, previewUrl: url });
  };

  const fmtTime = (iso: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const fmtNum = (n: number, digits: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: digits }).format(n);

  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${inputId}-title`}>
      <h2 id={`${inputId}-title`} className="text-xl font-semibold text-text">
        {t('capture.title')}
      </h2>
      <p className="text-base text-text-muted">{t('capture.noPatients')}</p>

      {step.kind !== 'review' && (
        <div>
          <input
            id={inputId}
            type="file"
            accept="image/jpeg,image/png"
            capture="environment"
            className="peer sr-only"
            onChange={(e) => void onChange(e)}
            disabled={step.kind === 'working'}
          />
          <label
            htmlFor={inputId}
            className="inline-flex min-h-touch min-w-touch cursor-pointer items-center justify-center rounded-md bg-action-primary px-4 py-2 text-base font-semibold text-action-primary-fg hover:bg-action-primary-hover peer-focus-visible:outline peer-focus-visible:outline-[3px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus"
          >
            {t('capture.take')}
          </label>
        </div>
      )}

      {step.kind === 'working' && <StateBoundary status="loading" messages={messages} />}
      {step.kind === 'error' && (
        <p role="alert" className="rounded-md bg-feedback-error p-3 text-feedback-error-fg">
          {t(`capture.problem.${step.problem}`)}
        </p>
      )}

      {step.kind === 'review' && (
        <div className="flex flex-col gap-3">
          {step.previewUrl && <img src={step.previewUrl} alt={t('capture.previewAlt')} className="max-h-[320px] w-auto rounded-md object-contain" />}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
            <dt className="font-semibold">{t('capture.time')}</dt>
            <dd>{fmtTime(step.photo.capturedAt)}</dd>
            <dt className="font-semibold">{t('capture.location')}</dt>
            <dd data-testid="gps">
              {step.photo.gps
                ? t('capture.gps', { lat: fmtNum(step.photo.gps.lat, 5), lng: fmtNum(step.photo.gps.lng, 5), accuracy: fmtNum(step.photo.gps.accuracyM, 0) })
                : t('capture.gpsUnavailable')}
            </dd>
            <dt className="font-semibold">{t('capture.fingerprint')}</dt>
            <dd className="break-all font-mono text-sm">{step.photo.sha256}</dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onCapture(step.photo)}>{t('capture.use')}</Button>
            <Button variant="secondary" onClick={() => setStep({ kind: 'idle' })}>
              {t('capture.retake')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
