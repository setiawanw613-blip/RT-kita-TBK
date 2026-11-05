// RT TBK: cache lama dibersihkan agar dashboard selalu mengikuti versi server.
self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Dokumen navigasi selalu diminta ulang dari server; tidak memakai cache lama.
  const options = req.mode === "navigate" ? { cache: "no-store" } : undefined;
  event.respondWith(fetch(req, options));
});
