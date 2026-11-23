import { getCached, putCached } from '../../offline/cache.js';
import type { FieldDb } from '../../offline/db.js';
import type { Draft } from './draft.js';

const draftKey = (assessmentId: string) => `assessment:draft:${assessmentId}`;
const INDEX = 'assessment:downloads';

/** A ward downloaded for offline use (what the ward list shows without network). */
export interface DownloadEntry {
  assessmentId: string;
  wardId: string;
  wardName: string;
  facilityName: string;
  cycleId: string;
}

/** Drafts and the download index live in the encrypted cache (Constitution VII). */
export async function saveDraft(db: FieldDb, key: CryptoKey, d: Draft): Promise<void> {
  await putCached(db, key, draftKey(d.assessmentId), d);
}

export async function loadDraft(db: FieldDb, key: CryptoKey, assessmentId: string): Promise<Draft | undefined> {
  return (await getCached<Draft>(db, key, draftKey(assessmentId)))?.value;
}

export async function listDownloads(db: FieldDb, key: CryptoKey): Promise<DownloadEntry[]> {
  return (await getCached<DownloadEntry[]>(db, key, INDEX))?.value ?? [];
}

export async function addDownload(db: FieldDb, key: CryptoKey, e: DownloadEntry): Promise<void> {
  const list = (await listDownloads(db, key)).filter((x) => x.assessmentId !== e.assessmentId);
  await putCached(db, key, INDEX, [...list, e]);
}
