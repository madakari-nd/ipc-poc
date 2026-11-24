import { useQuery } from '@tanstack/react-query';
import type { components } from '@ipc/contracts';
import { apiRequest } from '../../lib/api.js';

type S = components['schemas'];
export type OversightSummary = S['OversightSummary'];
export type OversightCounts = S['OversightCounts'];
export type OversightWardRow = S['OversightWardRow'];
export type DataQualityException = S['DataQualityException'];
export type DataQualityExceptionKind = S['DataQualityExceptionKind'];

interface Page<T> { items: T[]; nextCursor: string | null }

export const DQ_KINDS: DataQualityExceptionKind[] = [
  'PHOTO_NO_GPS', 'GPS_FAR_FROM_FACILITY', 'DEVICE_CLOCK_SKEW', 'LATE_UPLOAD', 'DUPLICATE_PHOTO_ACROSS_WARDS', 'NO_BASELINE', 'STALE_DEVICE_QUEUE',
];

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => v && p.set(k, v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Every page of a cursor list (oversight lists are small: one row per ward or exception). */
async function all<T>(path: string, params: Record<string, string | undefined>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await apiRequest<Page<T>>(`${path}${qs({ ...params, limit: '100', cursor })}`);
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

export const OVERSIGHT_KEYS = {
  summary: (districtCode?: string) => ['oversight', 'summary', districtCode ?? 'all'] as const,
  wards: (districtCode?: string, facilityId?: string) => ['oversight', 'wards', districtCode ?? 'all', facilityId ?? 'all'] as const,
  dq: (kind?: string) => ['oversight', 'dq', kind ?? 'all'] as const,
};

export const useOversightSummary = (districtCode?: string) =>
  useQuery({
    queryKey: OVERSIGHT_KEYS.summary(districtCode),
    queryFn: () => apiRequest<OversightSummary>(`/ipc/v1/oversight/summary${qs({ districtCode })}`),
  });

export const useOversightWards = (districtCode?: string, facilityId?: string) =>
  useQuery({
    queryKey: OVERSIGHT_KEYS.wards(districtCode, facilityId),
    queryFn: () => all<OversightWardRow>('/ipc/v1/oversight/wards', { districtCode, facilityId }),
  });

export const useDataQuality = (kind?: DataQualityExceptionKind) =>
  useQuery({
    queryKey: OVERSIGHT_KEYS.dq(kind),
    queryFn: () => all<DataQualityException>('/ipc/v1/oversight/data-quality-exceptions', { kind }),
  });
