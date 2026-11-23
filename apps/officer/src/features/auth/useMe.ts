import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiRequest, setCsrfToken } from '../../lib/api.js';
import { hasStoredLanguage, setLanguage } from '../../lib/i18n.js';
import type { Me, SessionResponse } from '../../lib/types.js';

export const ME_KEY = ['me'] as const;

function adopt(me: Me) {
  setCsrfToken(me.csrfToken);
  if (!hasStoredLanguage() && me.preferredLanguage) void setLanguage(me.preferredLanguage, false);
}

/** Current user from GET /ipc/v1/me (role, server-derived scope, CSRF token). */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      const me = await apiRequest<Me>('/ipc/v1/me');
      adopt(me);
      return me;
    },
    retry: (count, e) => !(e instanceof ApiError) && count < 2,
    staleTime: 5 * 60_000,
  });
}

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { identifier: string; password: string }) =>
      apiRequest<SessionResponse>('/ipc/v1/auth/login', { method: 'POST', body: { ...v, client: 'web' } }),
    onSuccess: (s) => {
      setCsrfToken(s.csrfToken);
      const me = { ...s.user, csrfToken: s.csrfToken };
      adopt(me);
      qc.setQueryData(ME_KEY, me);
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<void>('/ipc/v1/auth/logout', { method: 'POST' }),
    onSettled: () => {
      setCsrfToken(undefined);
      qc.clear();
    },
  });
}
