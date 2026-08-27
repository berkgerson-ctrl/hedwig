/* ============================================================
   HEDWIG — sw.js
   Caches the static app shell so the PWA installs cleanly and
   opens instantly from the home screen / app drawer. Firestore
   traffic and link-preview requests are always fetched live
   (chat should never show stale data), only the shell is cached.
   ============================================================ */

const CACHE_NAME = "hedwig-shell-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache Firestore, Google APIs, or link-preview calls — always go live.
  const isDynamic =
    url.hostname.includes("firestore") ||
    url.hostname.includes("googleapis") ||
    url.hostname.includes("gstatic") ||
    url.hostname.includes("microlink") ||
    url.hostname.includes("dicebear") ||
    url.hostname.includes("iconify");

  if (isDynamic || request.method !== "GET") {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  // App shell: cache-first, falling back to network, so the shell works offline.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
