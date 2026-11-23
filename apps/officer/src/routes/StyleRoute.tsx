import { LanguageSwitch, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { StyleGuide } from '../features/style/StyleGuide.js';
import { useStateMessages } from '../lib/boundary.js';
import { LANGUAGES, setLanguage } from '../lib/i18n.js';

/** Living style page (Constitution IX), public: it shows components only, no programme data. */
export function StyleRoute() {
  const { t, i18n } = useTranslation();
  const messages = useStateMessages();
  return (
    <div className="min-h-screen bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-6 py-3">
        <Link to="/" className="inline-flex min-h-touch items-center font-semibold text-action-primary underline">
          {t('style.backToApp')}
        </Link>
        <LanguageSwitch label={t('nav.language')} languages={[...LANGUAGES]} value={i18n.language} onChange={(c) => void setLanguage(c)} />
      </header>
      <main id="main" className="mx-auto max-w-[1100px] p-6">
        <StateBoundary status="ready" messages={messages}>
          <StyleGuide />
        </StateBoundary>
      </main>
    </div>
  );
}
