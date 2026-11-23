import { ToastProvider } from '@ipc/design-system';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/lib/i18n.js';
import { routes } from '../src/routes/router.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const me = (role: string, demoMode = true) => ({ userId: 'u1', name: 'Asha', activeRole: role, assignments: [], preferredLanguage: 'en', demoMode, csrfToken: 'c' });
const T = '2026-11-23T00:00:00.000Z';
const version = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id: `65f00000000000000000000${n}`, v: 1, createdAt: T, updatedAt: T, checklistCode: 'IPC-WARD', version: n, status,
  planTemplate: { version: n }, sections: [{ sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, wardTypes: [] }],
  questions: [{ questionKey: 'hand_rub', sectionKey: 'hand_hygiene', text: { en: `Hand rub v${n}` }, riskLevel: 'critical', passMark: 10, maxScore: 10 }],
  ...extra,
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function renderAt(path: string, handler: (c: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string | undefined };
    calls.push(c);
    return Promise.resolve(handler(c));
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider dismissLabel="Dismiss">
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe('programme setup screens (T074)', () => {
  it('shows the setup sections to the state administrator and refuses other roles', async () => {
    renderAt('/admin/cycles', ({ url }) => (url.endsWith('/me') ? json(200, me('STATE_ADMIN', false)) : json(200, { items: [], nextCursor: null })));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Programme setup sections' })).toBeTruthy());
    expect(await screen.findByText('No cycles yet')).toBeTruthy();
    cleanup();
    renderAt('/admin', () => json(200, me('IPC_OFFICER')));
    await waitFor(() => expect(screen.getByText('Back to home')).toBeTruthy());
  });

  it('publishes a draft through a confirm step with If-Match, and old versions stay readable', async () => {
    const calls = renderAt('/checklists', ({ url, method }) => {
      if (url.endsWith('/me')) return json(200, me('STATE_ADMIN', false));
      if (method === 'POST') return json(200, version(2, 'published'));
      if (url.includes('/checklists/65f000000000000000000001')) return json(200, version(1, 'published', { graceUntil: T }));
      return json(200, { items: [version(1, 'published', { graceUntil: T }), version(2, 'draft')], nextCursor: null });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Publish v2' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/ipc/v1/admin/checklists/65f000000000000000000002/publication');
    expect(post.headers['If-Match']).toBe('"1"');
    expect(post.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    fireEvent.click(screen.getByRole('button', { name: 'Show v1 questions' }));
    expect(await screen.findByText('Hand rub v1')).toBeTruthy();
    expect(screen.getByText('This version is published and read-only.')).toBeTruthy();
  });

  it('shows the demo-clock banner on every page while programme time is shifted', async () => {
    renderAt('/', ({ url }) => {
      if (url.endsWith('/me')) return json(200, me('IPC_OFFICER'));
      if (url.endsWith('/demo/clock')) return json(200, { v: 1, realNow: T, programmeNow: '2026-11-30T00:00:00.000Z', offsetMs: 604800000, isRealTime: false, demoMode: true });
      return json(200, { role: 'IPC_OFFICER', programmeNow: T, cards: [] });
    });
    expect((await screen.findByTestId('demo-clock-banner')).textContent).toMatch(/not real time/);
  });
});
