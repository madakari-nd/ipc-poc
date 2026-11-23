import { ApiError, apiRequest } from '../lib/api.js';
import type { Transport } from './outbox.js';

/** Real transport: Edge API with cookie + CSRF, and a cookie-less PUT to the signed storage URL. */
export const httpTransport: Transport = {
  request: (path, init) => apiRequest(path, init),
  async upload(url, method, headers, bytes, mime) {
    let res: Response;
    try {
      res = await fetch(url, { method, headers: { 'Content-Type': mime, ...headers }, body: bytes, credentials: 'omit' });
    } catch {
      throw new ApiError(503, { code: 'STORAGE_UNAVAILABLE', title: 'Upload failed', status: 503 });
    }
    // An expired or refused signed URL is retried with a fresh URL, so it is reported as transient.
    if (!res.ok) throw new ApiError(503, { code: 'STORAGE_UNAVAILABLE', title: `Upload failed (${res.status})`, status: 503 });
  },
};
