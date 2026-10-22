const CACHE_NAME = "rt-kita-v3-20261022";

const FILES_TO_CACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(
        FILES_TO_CACHE.map(url => new Request(url, { cache: "reload" }))
      );
    })
  );

  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;

  if (req.method !== "GET") return;

  // Halaman utama selalu diambil terbaru dari server (tanpa cache browser).
  const options = req.mode === "navigate" ? { cache: "no-store" } : undefined;

  event.respondWith(
    fetch(req, options).catch(() => caches.match(req))
  );
});
