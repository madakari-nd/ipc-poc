import { ToastProvider } from '@ipc/design-system';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/lib/i18n.js';
import { HistoryTimeline } from '../src/features/history/HistoryTimeline.js';
import { routes } from '../src/routes/router.js';

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

const TASK = '65c000000000000000000001';
const H = (c: string) => c.repeat(64);
const rec = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  at: `2026-11-2${seq}T10:00:00.000Z`,
  programmeAt: `2026-11-2${seq}T10:00:00.000Z`,
  actor: { userId: 'frontA1', role: 'FRONTLINE' },
  action: 'task.started',
  subject: { type: 'task', id: TASK },
  correlationId: `c${seq}`,
  prevHash: H(String(seq - 1)),
  hash: H(String(seq)),
  ...over,
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderTimeline(handler: (url: string) => Response) {
  const fetchMock = vi.fn((url: string) => Promise.resolve(handler(url)));
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <HistoryTimeline subjectType="task" subjectId={TASK} />
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe('HistoryTimeline (T066, SC-005, US9 AS5)', () => {
  it('shows every change with actor, role, time, reason and evidence fingerprints', async () => {
    const fetchMock = renderTimeline(() =>
      json(200, {
        items: [
          rec(1),
          rec(2, { action: 'task.returned', actor: { userId: 'supervisorA', role: 'WARD_SUPERVISOR' }, reason: 'Photo does not show the sink', beforeHash: H('a'), afterHash: H('b') }),
        ],
        nextCursor: null,
      }),
    );
    const list = await screen.findByRole('list', { name: 'Changes, oldest first' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const returned = items[1]!;
    expect(within(returned).getByText('supervisorA')).toBeTruthy();
    expect(within(returned).getByText('Ward supervisor')).toBeTruthy();
    expect(within(returned).getByText('Returned for changes')).toBeTruthy();
    expect(within(returned).getByText('Photo does not show the sink')).toBeTruthy();
    expect(within(returned).getByText(`${H('a').slice(0, 12)}…`).getAttribute('title')).toBe(H('a'));
    expect(within(returned).getByText(`${H('b').slice(0, 12)}…`)).toBeTruthy();
    expect(within(returned).getByText(/22 Nov 2026|Nov 22, 2026/)).toBeTruthy();
    expect(within(items[0]!).getByText('No reason recorded')).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`/ipc/v1/ledger/task/${TASK}?limit=50`);
  });

  it('loads further pages with the cursor', async () => {
    const fetchMock = renderTimeline((url) =>
      url.includes('cursor=') ? json(200, { items: [rec(3, { action: 'task.validated' })], nextCursor: null }) : json(200, { items: [rec(1)], nextCursor: 'abc' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Show older changes' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(String(fetchMock.mock.calls[1]![0])).toContain('cursor=abc');
    expect(screen.queryByRole('button', { name: 'Show older changes' })).toBeNull();
  });

  it('shows the empty and the denied states instead of a blank screen', async () => {
    renderTimeline(() => json(200, { items: [], nextCursor: null }));
    expect(await screen.findByText('No changes recorded yet')).toBeTruthy();
    cleanup();
    renderTimeline(() => json(403, { code: 'SCOPE_DENIED', title: 'Forbidden', status: 403 }));
    expect(await screen.findByText('You cannot open this')).toBeTruthy();
  });

  it('is translated (Hindi)', async () => {
    await i18n.changeLanguage('hi');
    renderTimeline(() => json(200, { items: [rec(1, { reason: 'x' })], nextCursor: null }));
    expect(await screen.findByRole('list', { name: 'बदलाव, सबसे पुराने पहले' })).toBeTruthy();
    expect(screen.getByText('फ्रंटलाइन स्टाफ़')).toBeTruthy();
  });
});

describe('history route', () => {
  it('opens the timeline for an allowed role at /history/:subjectType/:subjectId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes('/ledger/')
            ? json(200, { items: [rec(1)], nextCursor: null })
            : json(200, { userId: 'u1', name: 'Asha', activeRole: 'IPC_OFFICER', assignments: [], preferredLanguage: 'en', demoMode: false, csrfToken: 'c' }),
        ),
      ),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider dismissLabel="Dismiss">
          <RouterProvider router={createMemoryRouter(routes, { initialEntries: [`/history/task/${TASK}`] })} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'History' })).toBeTruthy();
    expect(await screen.findByText('Started')).toBeTruthy();
  });

  it('refuses roles without history access (mentor) with a way back', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { userId: 'm', name: 'M', activeRole: 'MENTOR', assignments: [], preferredLanguage: 'en', demoMode: false, csrfToken: 'c' }))));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider dismissLabel="Dismiss">
          <RouterProvider router={createMemoryRouter(routes, { initialEntries: [`/history/task/${TASK}`] })} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('You cannot open this')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to home' })).toBeTruthy();
  });
});
