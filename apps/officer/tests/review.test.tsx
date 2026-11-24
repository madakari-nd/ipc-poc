import { ToastProvider } from '@ipc/design-system';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/lib/i18n.js';
import { routes } from '../src/routes/router.js';

// jsdom has no scrollIntoView (Radix Select uses it).
Element.prototype.scrollIntoView ??= () => undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const me = (role: string) => ({ userId: 'u1', name: 'Leela', activeRole: role, assignments: [], preferredLanguage: 'en', demoMode: false, csrfToken: 'c' });
const TASK = '65c000000000000000000001';
const EV = '65c000000000000000000009';
const NOW = '2026-11-23T00:00:00.000Z';
const task = (over: Record<string, unknown> = {}) => ({
  id: TASK, v: 2, createdAt: NOW, updatedAt: NOW, planId: '65e000000000000000000001', wardId: '65b000000000000000000001', taskKey: 'k',
  title: { en: 'Fit hand-rub dispensers' }, riskLevel: 'critical', ownerUserId: 'front1', dueAt: '2026-11-30T00:00:00.000Z', dependsOnTaskIds: [],
  evidenceRule: { photoRequired: true, minPhotos: 1 }, secondValidation: true, state: 'EVIDENCE_SUBMITTED', rejectionCount: 0, blocked: null,
  currentEvidenceIds: [EV], syncState: 'in_sync', ...over,
});
const evidence = { id: EV, v: 1, createdAt: NOW, updatedAt: NOW, sha256: 'a'.repeat(64), sizeBytes: 10, mime: 'image/png', capturedAt: NOW, receivedAt: NOW, clockSkewSec: 0, gps: null, gpsUnavailable: true, uploadedBy: 'front1', facilityId: 'f', wardId: 'w', link: { type: 'task', id: TASK }, state: 'confirmed' };

function renderAt(path: string, role: string, handler: (url: string, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/ipc/v1/me')) return Promise.resolve(json(200, me(role)));
    if (url.includes('/ipc/v1/facilities')) return Promise.resolve(json(200, { items: [], nextCursor: null }));
    if (url.includes('/history')) return Promise.resolve(json(200, { task: task(), entries: [], decisions: [], escalations: [] }));
    if (url.endsWith(`/evidence/${EV}`)) return Promise.resolve(json(200, evidence));
    if (url.includes('/download-link')) return Promise.resolve(json(200, { url: 'http://store/x.png', method: 'GET', expiresAt: NOW, ttlSec: 300 }));
    return Promise.resolve(handler(url, init) ?? json(404, { code: 'NOT_FOUND' }));
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

describe('review and validation (T095)', () => {
  it('lists the supervisor review queue', async () => {
    renderAt('/reviews', 'WARD_SUPERVISOR', (url) => (url.includes('view=review_queue') ? json(200, { items: [task()], nextCursor: null }) : undefined));
    const list = await screen.findByRole('list', { name: 'Review queue' });
    expect(within(list).getByRole('link', { name: 'Review' }).getAttribute('href')).toBe(`/reviews/${TASK}`);
  });

  it('opens the proof through a signed URL and returns the task with a reason from the list (If-Match)', async () => {
    let returned = false;
    const f = renderAt(`/reviews/${TASK}`, 'WARD_SUPERVISOR', (url) => {
      if (url.endsWith('/return')) { returned = true; return json(200, task({ state: 'CHANGES_REQUESTED', v: 3, rejectionCount: 1 })); }
      if (url.endsWith(`/tasks/${TASK}`)) return json(200, returned ? task({ state: 'CHANGES_REQUESTED', v: 3, rejectionCount: 1 }) : task());
      return undefined;
    });
    expect(await screen.findByText('GPS unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View file' }));
    expect((await screen.findByRole('img', { name: 'Proof photo 1' })).getAttribute('src')).toBe('http://store/x.png');

    fireEvent.click(screen.getByRole('button', { name: 'Return' }));
    const dialog = await screen.findByRole('dialog', { name: 'Return this task with a reason?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Return to owner' }));
    expect(await within(dialog).findByText('Choose a reason from the list.')).toBeTruthy();
    expect(f.mock.calls.some(([u]) => String(u).endsWith('/return'))).toBe(false);
  });

  it('shows a 409 conflict in words and reloads the task', async () => {
    renderAt(`/reviews/${TASK}`, 'WARD_SUPERVISOR', (url) => {
      if (url.endsWith('/acceptance')) return json(409, { code: 'VERSION_CONFLICT', title: 'Conflict', status: 409, currentVersion: 3, current: task({ v: 3 }) });
      if (url.endsWith(`/tasks/${TASK}`)) return json(200, task());
      return undefined;
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept this proof?' });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Reason' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Meets the standard' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Someone changed this task/));
  });

  it('gives the IPC officer Validate on a pending task and no supervisor actions', async () => {
    renderAt(`/validations/${TASK}`, 'IPC_OFFICER', (url) => (url.endsWith(`/tasks/${TASK}`) ? json(200, task({ state: 'PENDING_VALIDATION' })) : undefined));
    expect(await screen.findByRole('button', { name: 'Validate' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull();
  });

  it('refuses the review queue to a frontline role', async () => {
    renderAt('/reviews', 'IPC_OFFICER', () => undefined);
    expect(await screen.findByText('You cannot open this')).toBeTruthy();
  });
});
