import { Button, PageHeader, StateBoundary } from '@ipc/design-system';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMe } from '../auth/useMe.js';
import { useStateMessages } from '../../lib/boundary.js';
import { MyRequests } from './MyRequests.js';
import { OfficerSupport } from './OfficerSupport.js';

/** `/support` (US6): officers raise and follow requests; a mentor sees only the requests sent to them. */
export function SupportRoute() {
  const { t } = useTranslation();
  const me = useMe().data;
  const messages = useStateMessages();
  if (!me) return null;
  const role = me.activeRole;
  const header = <PageHeader title={t('nav.support')} description={t(role === 'MENTOR' ? 'support.introMentor' : 'support.intro')} />;
  if (!['IPC_OFFICER', 'DISTRICT_QM', 'MENTOR', 'STATE_ADMIN'].includes(role)) {
    return (
      <>
        {header}
        <StateBoundary status="denied" messages={messages} deniedAction={<Button asChild variant="secondary"><Link to="/">{t('section.backHome')}</Link></Button>} />
      </>
    );
  }
  return (
    <>
      {header}
      {role === 'MENTOR' ? <MyRequests /> : <OfficerSupport canRaise={role === 'IPC_OFFICER' || role === 'DISTRICT_QM'} />}
    </>
  );
}
