import { StateBoundary } from '@ipc/design-system';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { errorStatus, useStateMessages } from '../../lib/boundary.js';
import { canUseFieldApp } from '../../lib/nav.js';
import { WrongApp } from '../shell/WrongApp.js';
import { useSession } from './SessionProvider.js';

/** Auth guard: bootstraps the session from GET /ipc/v1/me (or offline data) and checks the role. */
export function RequireSession() {
  const { query } = useSession();
  const messages = useStateMessages();
  const location = useLocation();
  if (query.isPending || query.isError) {
    return (
      <main id="main" className="mx-auto max-w-[720px] p-4">
        <StateBoundary status={query.isPending ? 'loading' : errorStatus(query.error)} messages={messages} onRetry={() => void query.refetch()} />
      </main>
    );
  }
  const s = query.data;
  if (s.status === 'signed_out') {
    return <Navigate to="/login" replace state={{ reason: s.reason, from: location.pathname }} />;
  }
  if (!canUseFieldApp(s.me.activeRole)) return <WrongApp />;
  return <Outlet />;
}
