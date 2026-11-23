const KEY = 'ipc-device-id';
let memoryId: string | undefined;

/** Stable per-install device id (not personal data); kept across sign-outs. */
export function deviceId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    memoryId ??= crypto.randomUUID();
    return memoryId;
  }
}
