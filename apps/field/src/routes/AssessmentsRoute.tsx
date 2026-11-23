import { PageHeader, StateBoundary, Button } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { WardList } from '../features/assessment/WardList.js';
import { useSignedIn } from '../features/session/SessionProvider.js';
import { useStateMessages } from '../lib/boundary.js';
import { canSee } from '../lib/nav.js';

/** US2: the wards the IPC officer or external auditor assesses, downloadable for offline work. */
export function AssessmentsRoute() {
  const { t } = useTranslation();
  const { me } = useSignedIn();
  const messages = useStateMessages();
  if (!canSee(me.activeRole, 'assessments')) {
    return (
      <>
        <PageHeader title={t('nav.assessments')} />
        <StateBoundary
          status="denied"
          messages={messages}
          deniedAction={
            <Button asChild variant="secondary">
              <Link to="/">{t('section.backHome')}</Link>
            </Button>
          }
        />
      </>
    );
  }
  return (
    <>
      <PageHeader title={t('assessment.list.title')} description={t('assessment.list.description')} />
      <WardList />
    </>
  );
}
