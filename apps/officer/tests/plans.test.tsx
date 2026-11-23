import { ToastProvider } from '@ipc/design-system';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/lib/i18n.js';
import { routes } from '../src/routes/router.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const me = (role: string) => ({ userId: 'u1', name: 'Asha', activeRole: role, assignments: [], preferredLanguage: 'en', demoMode: false, csrfToken: 'c' });

const PLAN = '65e000000000000000000001';
const NOW = '2026-11-23T00:00:00.000Z';
const draft = (over: Record<string, unknown> = {}) => ({
  id: PLAN, v: 1, createdAt: NOW, updatedAt: NOW, wardId: '65b000000000000000000001', facilityId: '65a000000000000000000001',
  cycleId: '65f000000000000000000001', sourceAssessmentId: '65d000000000000000000001', status: 'draft', planTemplateVersion: 1, revision: 0,
  goals: [], milestones: [], carriedOverTaskIds: [], draftCreatedAt: NOW, taskCounts: { critical: 1, high: 0, normal: 0 },
  draftTasks: [{
    taskKey: 'fit-hand-rub-dispensers', title: { en: 'Fit hand-rub dispensers' }, sourceQuestionKey: 'hand_rub_at_bed', riskLevel: 'critical', ownerUserId: 'front1',
    dueAt: '2026-11-30T00:00:00.000Z', dependsOnTaskKeys: [], evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true, included: true,
  }],
  tasks: [], unplannedFindings: [], ...over,
});

function renderAt(path: string, handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
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

const common = (url: string) => {
  if (url.endsWith('/ipc/v1/me')) return json(200, me('IPC_OFFICER'));
  if (url.includes('/ipc/v1/facilities')) return json(200, { items: [], nextCursor: null });
  if (url.includes('/ipc/v1/users')) return json(200, { items: [{ userId: 'front1', name: 'Ravi', roles: ['FRONTLINE'], active: true }], nextCursor: null });
  return undefined;
};

describe('officer plans (T088)', () => {
  it('shows "No actions needed" when the draft queue is empty', async () => {
    renderAt('/plans', (url) => common(url) ?? json(200, { items: [], nextCursor: null }));
    expect(await screen.findByText('No actions needed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Active plans' })).toBeTruthy();
  });

  it('lists a draft in the queue with its critical task count', async () => {
    renderAt('/plans', (url) => common(url) ?? json(200, { items: url.includes('status=draft') ? [draft()] : [], nextCursor: null }));
    const queue = await screen.findByRole('list', { name: 'Draft plans to review' });
    expect(within(queue).getByText('1 Critical')).toBeTruthy();
    expect(within(queue).getByRole('link', { name: 'Review draft' }).getAttribute('href')).toBe(`/plans/${PLAN}`);
  });

  it('approves the draft with If-Match after confirming', async () => {
    let approved = false;
    const active = () => draft({ status: 'active', revision: 1, v: 2, draftTasks: undefined });
    const fetchMock = renderAt(`/plans/${PLAN}`, (url) => {
      const c = common(url);
      if (c) return c;
      if (url.endsWith('/approval')) {
        approved = true;
        return json(200, active());
      }
      if (url.includes('/revisions')) return json(200, { items: [], nextCursor: null });
      return json(200, approved ? active() : draft());
    });
    expect(await screen.findByText('Fit hand-rub dispensers')).toBeTruthy();
    expect(screen.getByText(/photo proof/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve this plan?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and assign' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/approval'))).toBe(true));
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/approval'))!;
    expect((call[1]!.headers as Record<string, string>)['If-Match']).toBe('"1"');
    expect(await screen.findByRole('heading', { name: 'Plan history' })).toBeTruthy();
  });

  it('explains an ELEVATE outage on approval and keeps the draft', async () => {
    renderAt(`/plans/${PLAN}`, (url) => common(url) ?? (url.endsWith('/approval')
      ? json(503, { code: 'ELEVATE_UNAVAILABLE', title: 'Service Unavailable', status: 503 })
      : json(200, draft())));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve plan' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve and assign' }));
    expect(await screen.findByText(/ELEVATE is not available/)).toBeTruthy();
  });

  it('shows carried-over tasks and plan history on an active plan', async () => {
    const carried = {
      id: '65c000000000000000000009', v: 0, createdAt: NOW, updatedAt: NOW, planId: '65e000000000000000000000', wardId: '65b000000000000000000001',
      taskKey: 'clean', title: { en: 'Clean surfaces' }, riskLevel: 'normal', ownerUserId: 'front1', dueAt: NOW, dependsOnTaskIds: [],
      evidenceRule: { photoRequired: false, minPhotos: 0 }, secondValidation: false, state: 'IN_PROGRESS', rejectionCount: 0, syncState: 'in_sync',
    };
    renderAt(`/plans/${PLAN}`, (url) => common(url) ?? (url.includes('/revisions')
      ? json(200, { items: [{ id: 'r1', v: 0, createdAt: NOW, updatedAt: NOW, planId: PLAN, revision: 1, actorUserId: 'u1', role: 'IPC_OFFICER', reason: 'Plan approved', source: 'officer', changes: [{ op: 'add', taskId: 't' }] }], nextCursor: null })
      : json(200, draft({ status: 'active', revision: 1, draftTasks: undefined, tasks: [carried] }))));
    expect(await screen.findByRole('heading', { name: 'Carried over from the previous plan' })).toBeTruthy();
    expect(screen.getByText('Clean surfaces')).toBeTruthy();
    expect(await screen.findByText('Plan approved')).toBeTruthy();
    expect(screen.getByText(/1 added/)).toBeTruthy();
  });
});
