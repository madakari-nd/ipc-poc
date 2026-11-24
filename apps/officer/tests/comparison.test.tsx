import { ToastProvider } from '@ipc/design-system';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/lib/i18n.js';
import { formatChange } from '../src/features/comparison/ComparisonView.js';
import { routes } from '../src/routes/router.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Recharts measures its container; jsdom has none.
class RO { observe() {} unobserve() {} disconnect() {} }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const me = (role: string) => ({ userId: 'u1', name: 'Rahul', activeRole: role, assignments: [], preferredLanguage: 'en', demoMode: false, csrfToken: 'c' });
const A = '65d000000000000000000003';
const W = '65b000000000000000000001';
const NOW = '2026-12-23T10:00:00.000Z';
const held = { id: A, v: 3, createdAt: NOW, updatedAt: NOW, elevateObservationId: 'o', wardId: W, facilityId: '65a000000000000000000001', cycleId: 'c1', checklistVersionId: 'cv', checklistVersion: 1,
  assessorUserId: 'aud', assessorType: 'external', isBaselineForCycle: false, status: 'completed', completedAt: NOW, scores: { total: 20 }, failedQuestionKeys: [], releaseState: 'held', evidenceIds: [] };
const side = (total: number, version: number, assessorType: string) => ({ cycleId: 'c', checklistVersionId: `cv${version}`, checklistVersion: version, assessorType, total });
const comparison = {
  assessmentId: A, baselineAssessmentId: '65d000000000000000000001', wardId: W, facilityId: held.facilityId, totalChange: 10,
  current: side(20, 2, 'external'), baseline: side(0, 1, 'internal'),
  sections: [{ sectionKey: 'hand_hygiene', title: { en: 'Hand hygiene' }, current: 10, baseline: 0, change: 10, comparedQuestions: 1 }],
  notComparable: [{ questionKey: 'hh_posters', reason: 'text_changed' }],
};

function renderAt(path: string, role: string, handler: (url: string, init?: RequestInit) => Response | undefined) {
  vi.stubGlobal('ResizeObserver', RO);
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/ipc/v1/me')) return Promise.resolve(json(200, me(role)));
    if (url.includes('/ipc/v1/facilities')) return Promise.resolve(json(200, { items: [], nextCursor: null }));
    return Promise.resolve(handler(url, init) ?? json(404, { code: 'NOT_FOUND', title: 'Not found', status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider dismissLabel="Dismiss">
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe('comparison and release screens (T113)', () => {
  it('formats the change with a text sign', () => {
    expect([formatChange(10), formatChange(-5), formatChange(0)]).toEqual(['+10', '−5', '0']);
  });

  it('ComparisonView: both sides with versions, per-section change, not-comparable list and trend table', async () => {
    renderAt(`/assessments/${A}/comparison`, 'IPC_OFFICER', (url) => {
      if (url.endsWith('/comparison')) return json(200, comparison);
      if (url.endsWith('/trend')) return json(200, { wardId: W, points: [
        { cycleId: 'c0', cycleCode: '2026-C0', assessmentId: 'b', checklistVersion: 1, assessorType: 'internal', total: 0 },
        { cycleId: 'c1', cycleCode: '2026-C1', assessmentId: A, checklistVersion: 2, assessorType: 'external', total: 20 },
      ] });
      return undefined;
    });
    const table = await screen.findByRole('table', { name: 'Score by section' });
    expect(within(table).getByText('Hand hygiene')).toBeTruthy();
    expect(within(table).getByText('+10')).toBeTruthy();
    expect(screen.getByTestId('side-baseline').textContent).toContain('Version 1');
    expect(screen.getByTestId('side-current').textContent).toContain('Version 2');
    expect(screen.getByRole('heading', { name: 'Not comparable (version change)' })).toBeTruthy();
    expect(screen.getByText(/question wording changed/)).toBeTruthy();
    const trend = await screen.findByRole('table', { name: 'Scores by cycle' });
    expect(within(trend).getByText('2026-C1')).toBeTruthy();
  });

  it('ReleaseQueue: the district QM releases a held result with If-Match', async () => {
    const fetchMock = renderAt('/assessments', 'DISTRICT_QM', (url, init) => {
      if (url.endsWith('/release') && init?.method === 'POST') return json(200, { ...held, v: 4, releaseState: 'released' });
      if (url.includes('releaseState=held')) return json(200, { items: [held], nextCursor: null });
      if (url.includes('/ipc/v1/assessments?')) return json(200, { items: [], nextCursor: null });
      return undefined;
    });
    const queue = await screen.findByRole('list', { name: 'Results waiting for release' });
    fireEvent.click(within(queue).getByRole('button', { name: 'Release to hospital' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release this result to the hospital?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release result' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith(`/ipc/v1/assessments/${A}/release`))).toBe(true));
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/release'))!;
    expect((call[1]!.headers as Record<string, string>)['If-Match']).toBe('"3"');
  });

  it('the release queue is only for the district QM', async () => {
    renderAt('/assessments', 'EXTERNAL_AUDITOR', (url) => (url.includes('/ipc/v1/assessments?') ? json(200, { items: [held], nextCursor: null }) : undefined));
    expect(await screen.findByRole('heading', { name: 'Completed assessments' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Results waiting for release' })).toBeNull();
    expect(await screen.findByText('Held for release')).toBeTruthy();
  });
});
