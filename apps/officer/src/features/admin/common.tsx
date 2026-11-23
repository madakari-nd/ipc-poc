import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { errorKey, fieldErrors } from './api.js';

/** Locale-formatted date-time (Constitution VIII: dates follow the language). */
export function useFormatDate() {
  const { i18n } = useTranslation();
  return (iso?: string | null) => (iso ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—');
}

/** A titled panel inside an admin screen. */
export function Panel({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mb-6 flex flex-col gap-4 rounded-lg border border-border-subtle p-4" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold text-text">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** What went wrong and what to do next (never just a code). */
export function WriteError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const detail = fieldErrors(error);
  return (
    <div role="alert" className="rounded-md bg-feedback-error p-3 text-feedback-error-fg">
      <p className="font-semibold">{t(errorKey(error))}</p>
      {detail && <p className="text-sm">{detail}</p>}
    </div>
  );
}

/** Native checkbox with a 44 px target and a visible label. */
export function Check({ label, checked, onChange, id }: { label: string; checked: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <label htmlFor={id} className="flex min-h-touch items-center gap-2 text-base text-text">
      <input id={id} type="checkbox" className="h-5 w-5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** ISO from a `datetime-local` input value (local time) or undefined. */
export const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined);
