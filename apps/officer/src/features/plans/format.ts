import { useTranslation } from 'react-i18next';

/** Locale date (dates follow the chosen language). */
export function useDate() {
  const { i18n } = useTranslation();
  return (iso?: string | null) => (iso ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso)) : '—');
}

/** The task title in the chosen language, English when missing. */
export function useLocalized() {
  const { i18n } = useTranslation();
  return (text: { en: string; hi?: string; kn?: string }) => (text as Record<string, string | undefined>)[i18n.language] ?? text.en;
}
