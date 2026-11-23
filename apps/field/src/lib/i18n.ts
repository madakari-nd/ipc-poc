import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../i18n/en.json';
import hi from '../i18n/hi.json';
import kn from '../i18n/kn.json';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'kn', label: 'ಕನ್ನಡ' },
] as const;
export type LanguageCode = (typeof LANGUAGES)[number]['code'];

const STORAGE_KEY = 'ipc-field-lang';

function storedLanguage(): LanguageCode | undefined {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.some((l) => l.code === v) ? (v as LanguageCode) : undefined;
  } catch {
    return undefined;
  }
}

export function hasStoredLanguage(): boolean {
  return storedLanguage() !== undefined;
}

export async function setLanguage(code: string, remember = true): Promise<void> {
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // storage unavailable: the choice lasts for this visit only
    }
  }
  await i18n.changeLanguage(code);
}

// kn is partial (research T16): missing keys fall back to English.
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, hi: { translation: hi }, kn: { translation: kn } },
  lng: storedLanguage() ?? 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

i18n.on('languageChanged', (lng) => {
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
});

export default i18n;
