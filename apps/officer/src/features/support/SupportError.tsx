import { useTranslation } from 'react-i18next';
import { problemDetail } from '../plans/api.js';
import { supportErrorKey } from './api.js';

/** What went wrong with a support write and what to do next (never just a code). */
export function SupportError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const detail = problemDetail(error);
  return (
    <div role="alert" className="rounded-md bg-feedback-error p-3 text-feedback-error-fg">
      <p className="font-semibold">{t(supportErrorKey(error))}</p>
      {detail && <p className="text-sm">{detail}</p>}
    </div>
  );
}
