import type { ConfirmWithReasonLabels, SelectOption } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import type { ReasonCode } from './api.js';

/** Labels for ConfirmWithReason in the review screens (confirm is set per action). */
export function useReasonLabels(): ConfirmWithReasonLabels {
  const { t } = useTranslation();
  return {
    confirm: t('review.confirm'), cancel: t('common.cancel'), close: t('common.close'), reason: t('review.reason'),
    reasonPlaceholder: t('review.reasonPlaceholder'), reasonRequired: t('review.reasonRequired'), note: t('review.note'), noteHint: t('review.noteHint'),
  };
}

/** The FR-014 reason list as select options. */
export function useReasonOptions() {
  const { t } = useTranslation();
  return (codes: ReasonCode[]): SelectOption[] => codes.map((c) => ({ value: c, label: t(`review.reasons.${c}`) }));
}
