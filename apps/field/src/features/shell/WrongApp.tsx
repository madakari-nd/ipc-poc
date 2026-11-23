import { Button, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { useStateMessages } from '../../lib/boundary.js';
import { useSession } from '../session/SessionProvider.js';

/** Roles that work in the officer web (FR-036) get a clear next step instead of a dead end. */
export function WrongApp() {
  const { t } = useTranslation();
  const { signOut } = useSession();
  const messages = useStateMessages({ denied: { title: t('wrongApp.title'), description: t('wrongApp.description') } });
  return (
    <main id="main" className="mx-auto max-w-[720px] p-4">
      <StateBoundary
        status="denied"
        messages={messages}
        deniedAction={
          <>
            <Button asChild>
              <a href="/officer/">{t('wrongApp.action')}</a>
            </Button>
            <Button variant="secondary" onClick={() => void signOut()}>
              {t('nav.signOut')}
            </Button>
          </>
        }
      />
    </main>
  );
}
