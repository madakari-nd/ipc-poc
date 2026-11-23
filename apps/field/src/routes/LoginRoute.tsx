import { LanguageSwitch, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LoginForm } from '../features/auth/LoginForm.js';
import { useSession, type SignedOutReason } from '../features/session/SessionProvider.js';
import { errorStatus, useStateMessages } from '../lib/boundary.js';
import { LANGUAGES, setLanguage } from '../lib/i18n.js';

const reasonKey: Record<SignedOutReason, string> = {
  expired: 'auth.expired',
  logged_out: 'auth.loggedOut',
  session_ended: 'auth.sessionEnded',
  unlock: 'auth.unlock',
  offline: 'auth.offline',
};

export function LoginRoute() {
  const { t, i18n } = useTranslation();
  const { query, signIn } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const messages = useStateMessages();
  const navState = location.state as { reason?: SignedOutReason; from?: string } | null;
  const reason = navState?.reason ?? (query.data?.status === 'signed_out' ? query.data.reason : undefined);

  if (query.data?.status === 'signed_in') return <Navigate to={navState?.from ?? '/'} replace />;

  return (
    <main id="main" className="mx-auto flex max-w-[480px] flex-col gap-4 p-4">
      <div className="flex justify-end">
        <LanguageSwitch label={t('nav.language')} languages={[...LANGUAGES]} value={i18n.language} onChange={(c) => void setLanguage(c)} />
      </div>
      <PageHeader title={t('auth.title')} description={t('app.name')} />
      <StateBoundary status={query.isPending ? 'loading' : query.isError ? errorStatus(query.error) : 'ready'} messages={messages} onRetry={() => void query.refetch()}>
        {reason && (
          <p role="status" className="rounded-md bg-feedback-info p-3 text-feedback-info-fg">
            {t(reasonKey[reason])}
          </p>
        )}
        <LoginForm
          onSubmit={async (id, pw) => {
            await signIn(id, pw);
            navigate(navState?.from ?? '/', { replace: true });
          }}
        />
      </StateBoundary>
    </main>
  );
}
