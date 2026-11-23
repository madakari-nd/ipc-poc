import { Button, Dialog, LanguageSwitch, cn } from '@ipc/design-system';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LANGUAGES, setLanguage } from '../../lib/i18n.js';
import { navFor } from '../../lib/nav.js';
import { OUTBOX_KEY, useSession, useSignedIn } from '../session/SessionProvider.js';

export function AppShell() {
  const { t, i18n } = useTranslation();
  const { me, offline, guard, outbox } = useSignedIn();
  const { signOut } = useSession();
  const navigate = useNavigate();
  const [confirmOut, setConfirmOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const items = useQuery({ queryKey: OUTBOX_KEY, queryFn: () => outbox.list() });
  const unsent = (items.data ?? []).filter((i) => i.status !== 'sent').length;

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:p-2">
        {t('app.skipToContent')}
      </a>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-4 py-2">
        <div className="flex flex-col">
          <span className="text-lg font-bold text-text">{t('app.name')}</span>
          <span className="text-sm text-text-muted">
            {me.name} · {t(`roles.${me.activeRole}`)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitch label={t('nav.language')} languages={[...LANGUAGES]} value={i18n.language} onChange={(c) => void setLanguage(c)} />
          <Button variant="secondary" onClick={() => setConfirmOut(true)}>
            {t('nav.signOut')}
          </Button>
        </div>
      </header>
      {offline && (
        <p role="status" className="bg-feedback-offline px-4 py-2 text-sm text-feedback-offline-fg">
          {t('offlineGuard.offline')}
        </p>
      )}
      {guard.status === 'warn' && (
        <p role="alert" className="bg-feedback-warning px-4 py-2 text-sm font-semibold text-feedback-warning-fg">
          {t('offlineGuard.warn', { count: guard.daysLeft })}
        </p>
      )}
      <nav aria-label={t('nav.label')} className="border-b border-border-subtle px-2">
        <ul className="flex flex-wrap gap-1">
          {navFor(me.activeRole).map((n) => (
            <li key={n.section}>
              <NavLink
                to={n.path}
                end={n.path === '/'}
                className={({ isActive }) =>
                  cn(
                    'inline-flex min-h-touch items-center rounded-md px-3 text-base font-semibold text-text no-underline',
                    'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-focus',
                    isActive ? 'bg-action-secondary text-action-secondary-fg' : 'hover:bg-surface-muted',
                  )
                }
              >
                {t(n.labelKey)}
                {n.section === 'queue' && unsent > 0 && <span className="ml-1">({unsent})</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="mx-auto w-full max-w-[960px] flex-1 p-4">
        <Outlet />
      </main>
      <Dialog
        open={confirmOut}
        onOpenChange={setConfirmOut}
        title={t('signOut.title')}
        description={t('signOut.description')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOut(false)}>
              {t('signOut.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                await signOut();
                setBusy(false);
                setConfirmOut(false);
                navigate('/login', { replace: true });
              }}
            >
              {t('signOut.confirm')}
            </Button>
          </>
        }
      >
        {unsent > 0 && (
          <p role="alert" className="rounded-md bg-feedback-warning p-3 font-semibold text-feedback-warning-fg">
            {t('signOut.pendingWarning', { count: unsent })}
          </p>
        )}
      </Dialog>
    </div>
  );
}
