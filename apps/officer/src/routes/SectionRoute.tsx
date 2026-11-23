import { Button, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useMe } from '../features/auth/useMe.js';
import { useStateMessages } from '../lib/boundary.js';
import { SECTIONS, canSee, type Section } from '../lib/nav.js';
import { NotFoundRoute } from './NotFoundRoute.js';

/** Role areas whose journeys arrive in later tasks: clear message and a way back, never a blank page. */
export function SectionRoute() {
  const { t } = useTranslation();
  const { section = '' } = useParams();
  const me = useMe().data;
  const messages = useStateMessages({ empty: { title: t('section.comingSoon.title'), description: t('section.comingSoon.description') } });
  if (!me || !SECTIONS.includes(section as Section)) return <NotFoundRoute />;
  const home = (
    <Button asChild variant="secondary">
      <Link to="/">{t('section.backHome')}</Link>
    </Button>
  );
  return (
    <>
      <PageHeader title={t(`nav.${section}`)} />
      <StateBoundary status={canSee(me.activeRole, section as Section) ? 'empty' : 'denied'} messages={messages} emptyAction={home} deniedAction={home} />
    </>
  );
}
