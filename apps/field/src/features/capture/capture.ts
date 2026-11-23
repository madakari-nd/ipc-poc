import { sha256Hex, type Bytes } from '../../offline/crypto.js';

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
export const PHOTO_MIMES = ['image/jpeg', 'image/png'] as const;
export type PhotoMime = (typeof PHOTO_MIMES)[number];

export interface Gps {
  lat: number;
  lng: number;
  accuracyM: number;
}

export interface CapturedPhoto {
  bytes: Bytes;
  sha256: string;
  sizeBytes: number;
  mime: PhotoMime;
  /** Device time at capture (ISO 8601). The server records its own receive time and the skew. */
  capturedAt: string;
  gps: Gps | null;
  gpsUnavailable: boolean;
}

export type CaptureProblem = 'type' | 'size' | 'read';

export type PositionGetter = () => Promise<Gps | null>;

/** Current position, or null when GPS is off, refused or too slow (the "GPS unavailable" flag). */
export const browserPosition: PositionGetter = () =>
  new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  });

async function readBytes(file: Blob): Promise<Bytes> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsArrayBuffer(file);
  });
}

/** Builds the evidence record on the device: bytes, SHA-256 (Web Crypto), device time and GPS. */
export async function capturePhoto(
  file: File,
  opts: { getPosition?: PositionGetter; now?: () => Date } = {},
): Promise<{ ok: true; photo: CapturedPhoto } | { ok: false; problem: CaptureProblem }> {
  const capturedAt = (opts.now ?? (() => new Date()))().toISOString();
  if (!PHOTO_MIMES.includes(file.type as PhotoMime)) return { ok: false, problem: 'type' };
  if (file.size <= 0 || file.size > MAX_EVIDENCE_BYTES) return { ok: false, problem: 'size' };
  let bytes: Bytes;
  try {
    bytes = await readBytes(file);
  } catch {
    return { ok: false, problem: 'read' };
  }
  const [sha256, gps] = await Promise.all([sha256Hex(bytes), (opts.getPosition ?? browserPosition)()]);
  return {
    ok: true,
    photo: { bytes, sha256, sizeBytes: bytes.byteLength, mime: file.type as PhotoMime, capturedAt, gps, gpsUnavailable: gps === null },
  };
}
