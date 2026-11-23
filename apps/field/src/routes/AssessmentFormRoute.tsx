import { Button, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { AssessmentForm } from '../features/assessment/AssessmentForm.js';
import { useSignedIn } from '../features/session/SessionProvider.js';
import { useStateMessages } from '../lib/boundary.js';
import { canSee } from '../lib/nav.js';

/** US2: one downloaded ward assessment, usable offline. */
export function AssessmentFormRoute() {
  const { t } = useTranslation();
  const { assessmentId = '' } = useParams();
  const { me } = useSignedIn();
  const messages = useStateMessages();
  const back = (
    <Button asChild variant="secondary">
      <Link to="/assessments">{t('assessment.form.backToList')}</Link>
    </Button>
  );
  return (
    <>
      <PageHeader title={t('assessment.form.title')} back={<Link to="/assessments">{t('assessment.form.backToList')}</Link>} />
      {canSee(me.activeRole, 'assessments') ? <AssessmentForm assessmentId={assessmentId} /> : <StateBoundary status="denied" messages={messages} deniedAction={back} />}
    </>
  );
}
