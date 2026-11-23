import { Button, LanguageSwitch, cn } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LANGUAGES, setLanguage } from '../../lib/i18n.js';
import { navFor } from '../../lib/nav.js';
import { useMe, useSignOut } from '../auth/useMe.js';

export function AppShell() {
  const { t, i18n } = useTranslation();
  const me = useMe().data;
  const signOut = useSignOut();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <div className="flex min-h-screen flex-col bg-surface md:flex-row">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:p-2">
        {t('app.skipToContent')}
      </a>
      <nav aria-label={t('nav.label')} className="border-b border-border-subtle bg-surface-muted p-3 md:min-h-screen md:w-[240px] md:border-b-0 md:border-r">
        <p className="mb-3 px-2 text-lg font-bold text-text">{t('app.name')}</p>
        <ul className="flex flex-wrap gap-1 md:flex-col">
          {navFor(me.activeRole).map((n) => (
            <li key={n.section}>
              <NavLink
                to={n.path}
                end={n.path === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-touch items-center rounded-md px-3 text-base font-semibold text-text no-underline',
                    'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-focus',
                    isActive ? 'bg-action-secondary text-action-secondary-fg' : 'hover:bg-surface',
                  )
                }
              >
                {t(n.labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
        <p className="mt-6 px-2 text-sm">
          <Link to="/style" className="text-text-muted underline">
            {t('nav.style')}
          </Link>
        </p>
      </nav>
      <div className="flex flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-end gap-3 border-b border-border-subtle px-4 py-2">
          <span className="text-sm text-text-muted">
            {me.name} · {t(`roles.${me.activeRole}`)}
          </span>
          <LanguageSwitch label={t('nav.language')} languages={[...LANGUAGES]} value={i18n.language} onChange={(c) => void setLanguage(c)} />
          <Button
            variant="secondary"
            busy={signOut.isPending}
            onClick={() => signOut.mutate(undefined, { onSettled: () => navigate('/login', { replace: true, state: { reason: 'logged_out' } }) })}
          >
            {t('nav.signOut')}
          </Button>
        </header>
        <main id="main" className="w-full max-w-[1200px] flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
