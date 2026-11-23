import { StateBoundary } from '@ipc/design-system';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ApiError } from '../../lib/api.js';
import { errorStatus, useStateMessages } from '../../lib/boundary.js';
import { canUseOfficerWeb } from '../../lib/nav.js';
import { WrongApp } from '../shell/WrongApp.js';
import { useMe } from './useMe.js';

/** Auth guard: GET /ipc/v1/me; 401 goes to sign-in, other failures get a next step. */
export function RequireAuth() {
  const me = useMe();
  const messages = useStateMessages();
  const location = useLocation();
  if (me.isError && me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location.pathname, reason: me.error.code === 'SESSION_EXPIRED' ? 'expired' : undefined }} />;
  }
  if (me.isPending || me.isError) {
    return (
      <main id="main" className="mx-auto max-w-[720px] p-4">
        <StateBoundary status={me.isPending ? 'loading' : errorStatus(me.error)} messages={messages} onRetry={() => void me.refetch()} />
      </main>
    );
  }
  if (!canUseOfficerWeb(me.data.activeRole)) return <WrongApp />;
  return <Outlet />;
}
