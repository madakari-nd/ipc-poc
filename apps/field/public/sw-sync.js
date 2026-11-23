/* global self */
// Imported by the Workbox service worker. The outbox key lives only in the app (derived from the
// password), so on a Background Sync event the worker asks open app windows to flush the outbox.
// If no window is open, items stay queued and are sent on the next foreground start.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'ipc-outbox') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      clients.forEach((c) => c.postMessage({ type: 'ipc-outbox-sync' }));
    }),
  );
});
