import { Button, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useSignedIn } from '../features/session/SessionProvider.js';
import { useStateMessages } from '../lib/boundary.js';
import { canSee, type Section } from '../lib/nav.js';
import { NotFoundRoute } from './NotFoundRoute.js';

const KNOWN: Section[] = ['tasks', 'reviews', 'assessments'];

/** Role sections whose journeys are built in later tasks: a clear next step, never a blank page. */
export function SectionRoute() {
  const { t } = useTranslation();
  const { section = '' } = useParams();
  const { me } = useSignedIn();
  const messages = useStateMessages({
    empty: { title: t('section.comingSoon.title'), description: t('section.comingSoon.description') },
    denied: { title: t('state.denied.title'), description: t('state.denied.description') },
  });
  if (!KNOWN.includes(section as Section)) return <NotFoundRoute />;
  const allowed = canSee(me.activeRole, section as Section);
  const home = (
    <Button asChild variant="secondary">
      <Link to="/">{t('section.backHome')}</Link>
    </Button>
  );
  return (
    <>
      <PageHeader title={t(`nav.${section}`)} />
      <StateBoundary status={allowed ? 'empty' : 'denied'} messages={messages} emptyAction={home} deniedAction={home} />
    </>
  );
}
