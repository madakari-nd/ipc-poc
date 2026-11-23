import { LanguageSwitch, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LoginForm } from '../features/auth/LoginForm.js';
import { useMe, useSignIn } from '../features/auth/useMe.js';
import { useStateMessages } from '../lib/boundary.js';
import { LANGUAGES, setLanguage } from '../lib/i18n.js';

export function LoginRoute() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const signIn = useSignIn();
  const navigate = useNavigate();
  const messages = useStateMessages();
  const state = useLocation().state as { from?: string; reason?: 'expired' | 'logged_out' } | null;
  const from = state?.from && state.from !== '/login' ? state.from : '/';

  if (me.data) return <Navigate to={from} replace />;

  return (
    <main id="main" className="mx-auto flex max-w-[480px] flex-col gap-4 p-6">
      <div className="flex justify-end">
        <LanguageSwitch label={t('nav.language')} languages={[...LANGUAGES]} value={i18n.language} onChange={(c) => void setLanguage(c)} />
      </div>
      <PageHeader title={t('auth.title')} description={t('app.name')} />
      <StateBoundary status={me.isPending ? 'loading' : 'ready'} messages={messages}>
        {state?.reason && (
          <p role="status" className="rounded-md bg-feedback-info p-3 text-feedback-info-fg">
            {t(state.reason === 'expired' ? 'auth.expired' : 'auth.loggedOut')}
          </p>
        )}
        <LoginForm
          onSubmit={async (identifier, password) => {
            await signIn.mutateAsync({ identifier, password });
            navigate(from, { replace: true });
          }}
        />
      </StateBoundary>
    </main>
  );
}
