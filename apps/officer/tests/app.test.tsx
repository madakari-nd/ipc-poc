import { ToastProvider } from '@ipc/design-system';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/lib/i18n.js';
import { routes } from '../src/routes/router.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderAt(path: string, handler: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(handler(url))));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider dismissLabel="Dismiss">
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

const me = (role: string) => ({ userId: 'u1', name: 'Asha', activeRole: role, assignments: [], preferredLanguage: 'en', demoMode: false, csrfToken: 'c' });

describe('auth guard and role home', () => {
  it('sends a signed-out user to sign-in', async () => {
    const router = renderAt('/', () => json(401, { code: 'UNAUTHENTICATED', title: 'x', status: 401 }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy();
  });

  it('shows the role nav and the home cards for an IPC officer', async () => {
    renderAt('/', (url) =>
      url.endsWith('/me/home')
        ? json(200, { role: 'IPC_OFFICER', programmeNow: '2026-11-01T00:00:00Z', cards: [{ kind: 'validation_queue', count: 2 }, { kind: 'draft_plans', count: 0 }] })
        : json(200, me('IPC_OFFICER')),
    );
    await waitFor(() => expect(screen.getByText('Tasks to validate')).toBeTruthy());
    const nav = screen.getByRole('navigation', { name: 'Main menu' });
    expect(nav.textContent).toContain('Validations');
    expect(nav.textContent).not.toContain('Programme setup');
    expect(screen.queryByText('Draft plans')).toBeNull();
  });

  it('sends frontline staff to the field app instead of a dead end', async () => {
    renderAt('/', () => json(200, me('FRONTLINE')));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Open the field app' }).getAttribute('href')).toBe('/field/'));
  });

  it('refuses an area outside the role with a way back home', async () => {
    renderAt('/admin', () => json(200, me('MENTOR')));
    await waitFor(() => expect(screen.getByText('You cannot open this')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Back to home' })).toBeTruthy();
  });
});

describe('living style page', () => {
  it('renders every state chip, risk chip and legend chip with a text label, without signing in', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider dismissLabel="Dismiss">
          <RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/style'] })} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Design system' })).toBeTruthy();
    for (const label of ['Assigned', 'Waiting for validation', 'Closed', 'Critical', 'ELEVATE reused', 'Built on top']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole('table', { name: 'Semantic colour tokens' })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
