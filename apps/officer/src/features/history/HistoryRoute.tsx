import { Button, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useMe } from '../auth/useMe.js';
import { useStateMessages } from '../../lib/boundary.js';
import type { Role } from '../../lib/types.js';
import { NotFoundRoute } from '../../routes/NotFoundRoute.js';
import { HistoryTimeline, type LedgerSubjectType } from './HistoryTimeline.js';

/** contracts `getEntityLedger` x-roles; the Edge enforces the same list and the entity scope. */
export const HISTORY_ROLES: readonly Role[] = ['STATE_ADMIN', 'DISTRICT_QM', 'IPC_OFFICER', 'WARD_SUPERVISOR', 'EXTERNAL_AUDITOR'];

const SUBJECT_TYPES: readonly LedgerSubjectType[] = [
  'programme', 'facility', 'ward', 'cycle', 'scope_assignment', 'checklist_version', 'risk_default', 'escalation_rule',
  'assessment', 'evidence', 'plan', 'task', 'escalation', 'support_request', 'clock', 'import_job', 'retention_policy',
];

/** `/history/:subjectType/:subjectId`: the full history of one item on one screen. */
export function HistoryRoute() {
  const { t } = useTranslation();
  const { subjectType = '', subjectId = '' } = useParams();
  const me = useMe().data;
  const messages = useStateMessages();
  if (!me || !SUBJECT_TYPES.includes(subjectType as LedgerSubjectType) || !/^[A-Za-z0-9_:-]{1,64}$/.test(subjectId)) return <NotFoundRoute />;
  const header = <PageHeader title={t('history.title')} description={t('history.intro', { type: t(`history.subjects.${subjectType}`) })} />;
  if (!HISTORY_ROLES.includes(me.activeRole)) {
    return (
      <>
        {header}
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
      {header}
      <HistoryTimeline subjectType={subjectType as LedgerSubjectType} subjectId={subjectId} />
    </>
  );
}
