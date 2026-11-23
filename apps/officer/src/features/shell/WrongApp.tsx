import { Button, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useStateMessages } from '../../lib/boundary.js';
import { useSignOut } from '../auth/useMe.js';

/** Frontline staff work in the field app (FR-036): give them the way there. */
export function WrongApp() {
  const { t } = useTranslation();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const messages = useStateMessages({ denied: { title: t('wrongApp.title'), description: t('wrongApp.description') } });
  return (
    <main id="main" className="mx-auto max-w-[720px] p-4">
      <StateBoundary
        status="denied"
        messages={messages}
        deniedAction={
          <>
            <Button asChild>
              <a href="/field/">{t('wrongApp.action')}</a>
            </Button>
            <Button variant="secondary" onClick={() => signOut.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}>
              {t('nav.signOut')}
            </Button>
          </>
        }
      />
    </main>
  );
}
