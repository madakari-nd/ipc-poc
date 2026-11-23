import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ApiError, NetworkError, apiRequest, setCsrfToken } from '../../lib/api.js';
import { deviceId } from '../../lib/device.js';
import { hasStoredLanguage, setLanguage } from '../../lib/i18n.js';
import type { Me, SessionResponse } from '../../lib/types.js';
import { getCached, putCached } from '../../offline/cache.js';
import { sha256Hex } from '../../offline/crypto.js';
import { openDb, type FieldDb } from '../../offline/db.js';
import { Outbox } from '../../offline/outbox.js';
import {
  enforceOfflineGuard,
  establishOfflineSession,
  loadOfflineSession,
  markOnline,
  signOutAndWipe,
  type GuardState,
} from '../../offline/session.js';
import { SyncRunner, registerBackgroundSync } from '../../offline/sync.js';
import { httpTransport } from '../../offline/transport.js';

export type SignedOutReason = 'expired' | 'logged_out' | 'session_ended' | 'unlock' | 'offline';

export type SessionState =
  | { status: 'signed_out'; reason?: SignedOutReason }
  | { status: 'signed_in'; me: Me; offline: boolean; guard: GuardState; outbox: Outbox; db: FieldDb; /** Offline store key (drafts are kept encrypted, US2). */ key: CryptoKey };

interface SessionApi {
  query: UseQueryResult<SessionState>;
  signIn: (identifier: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Ask for a send now and register background sync for when the network returns. */
  requestSync: () => void;
}

const SessionContext = createContext<SessionApi | null>(null);
export const SESSION_KEY = ['session'] as const;
export const OUTBOX_KEY = ['outbox'] as const;
const GUARD_CHECK_MS = 60_000;

/** Fallback when the Edge does not yet return `offlineKeySalt`: per user and device, not secret. */
async function fallbackSalt(userId: string): Promise<string> {
  const hex = await sha256Hex(new TextEncoder().encode(`ipc-field-salt:${userId}:${deviceId()}`));
  return btoa(String.fromCharCode(...(hex.match(/../g) ?? []).map((h) => parseInt(h, 16))));
}

function applyPreferredLanguage(me: Me) {
  if (!hasStoredLanguage() && me.preferredLanguage) void setLanguage(me.preferredLanguage, false);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const dbRef = useRef<FieldDb>(openDb());
  const runnerRef = useRef<SyncRunner | null>(null);

  const makeState = useCallback(
    (me: Me, key: CryptoKey, offline: boolean, guard: GuardState): SessionState => ({
      status: 'signed_in',
      me,
      offline,
      guard,
      db: dbRef.current,
      key,
      outbox: new Outbox({ db: dbRef.current, key, transport: httpTransport, deviceId: deviceId(), appVersion: '0.1.0' }),
    }),
    [],
  );

  const bootstrap = useCallback(async (): Promise<SessionState> => {
    const db = dbRef.current;
    const guard = await enforceOfflineGuard(db);
    if (guard.status === 'expired') {
      dbRef.current = openDb();
      return { status: 'signed_out', reason: 'expired' };
    }
    const local = await loadOfflineSession(db);
    try {
      const me = await apiRequest<Me>('/ipc/v1/me');
      setCsrfToken(me.csrfToken);
      applyPreferredLanguage(me);
      // The offline key is derived from the password, so a new sign-in is needed without it.
      if (!local || local.userId !== me.userId) return { status: 'signed_out', reason: 'unlock' };
      await markOnline(db);
      await putCached(db, local.key, 'me', me);
      return makeState(me, local.key, false, { status: 'ok', daysLeft: 7 });
    } catch (e) {
      if (e instanceof NetworkError) {
        if (local) {
          const cached = await getCached<Me>(db, local.key, 'me');
          if (cached) return makeState(cached.value, local.key, true, guard);
        }
        return { status: 'signed_out', reason: 'offline' };
      }
      if (e instanceof ApiError && e.status === 401) return { status: 'signed_out', reason: local ? 'session_ended' : undefined };
      throw e;
    }
  }, [makeState]);

  const query = useQuery<SessionState>({ queryKey: SESSION_KEY, queryFn: bootstrap, staleTime: Infinity, retry: false });
  const state = query.data;

  const signIn = useCallback(
    async (identifier: string, password: string) => {
      const s = await apiRequest<SessionResponse>('/ipc/v1/auth/login', {
        method: 'POST',
        body: { identifier, password, client: 'field', deviceId: deviceId() },
      });
      setCsrfToken(s.csrfToken);
      applyPreferredLanguage(s.user);
      const salt = s.offlineKeySalt ?? (await fallbackSalt(s.user.userId));
      const key = await establishOfflineSession(dbRef.current, { userId: s.user.userId, password, saltB64: salt });
      await putCached(dbRef.current, key, 'me', s.user);
      qc.setQueryData<SessionState>(SESSION_KEY, makeState(s.user, key, false, { status: 'ok', daysLeft: 7 }));
    },
    [qc, makeState],
  );

  const signOut = useCallback(async () => {
    runnerRef.current?.stop();
    await signOutAndWipe(dbRef.current, httpTransport);
    dbRef.current = openDb();
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
    qc.setQueryData<SessionState>(SESSION_KEY, { status: 'signed_out', reason: 'logged_out' });
  }, [qc]);

  // Foreground sync while signed in.
  const outbox = state?.status === 'signed_in' ? state.outbox : undefined;
  useEffect(() => {
    if (!outbox) return;
    const runner = new SyncRunner(outbox, {
      onAuthRequired: () => qc.setQueryData<SessionState>(SESSION_KEY, { status: 'signed_out', reason: 'session_ended' }),
      onAfterRun: () => void qc.invalidateQueries({ queryKey: OUTBOX_KEY }),
    });
    runnerRef.current = runner;
    runner.start();
    return () => runner.stop();
  }, [outbox, qc]);

  // 7-day guard on device time, checked every minute while the app is open.
  useEffect(() => {
    if (state?.status !== 'signed_in') return;
    const id = setInterval(() => {
      void enforceOfflineGuard(dbRef.current).then((g) => {
        if (g.status === 'expired') {
          dbRef.current = openDb();
          qc.setQueryData<SessionState>(SESSION_KEY, { status: 'signed_out', reason: 'expired' });
        } else if (g.status !== state.guard.status) {
          qc.setQueryData<SessionState>(SESSION_KEY, { ...state, guard: g });
        }
      });
    }, GUARD_CHECK_MS);
    return () => clearInterval(id);
  }, [state, qc]);

  // Coming back online after an offline start: refresh the session (and the 7-day clock).
  const offline = state?.status === 'signed_in' && state.offline;
  useEffect(() => {
    if (!offline) return;
    const onOnline = () => void qc.invalidateQueries({ queryKey: SESSION_KEY });
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [offline, qc]);

  const requestSync = useCallback(() => {
    void registerBackgroundSync();
    void runnerRef.current?.run();
  }, []);

  const api = useMemo(() => ({ query, signIn, signOut, requestSync }), [query, signIn, signOut, requestSync]);
  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/** The signed-in state; only for components rendered behind <RequireSession>. */
export function useSignedIn(): Extract<SessionState, { status: 'signed_in' }> {
  const { query } = useSession();
  if (query.data?.status !== 'signed_in') throw new Error('useSignedIn used outside a signed-in route');
  return query.data;
}
