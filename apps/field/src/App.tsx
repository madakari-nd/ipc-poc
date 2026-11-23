import { ToastProvider } from '@ipc/design-system';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RouterProvider } from 'react-router-dom';
import { SessionProvider } from './features/session/SessionProvider.js';
import { ApiError } from './lib/api.js';
import { router } from './routes/router.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Never retry permission or validation errors; retry the rest twice.
      retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2,
      networkMode: 'always',
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  const { t } = useTranslation();
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider dismissLabel={t('common.dismiss')}>
        <SessionProvider>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </SessionProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
