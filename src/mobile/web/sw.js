// AnxOS phone app service worker.
//
// Caches only the app shell (HTML, CSS, JS, icons) so the app opens and can
// say "can't reach AnxOS" when the computer is off or out of range. API
// responses are never cached: server data, consoles and files always come
// live from the computer, or not at all.

const CACHE = "anxos-shell-v2";
const SHELL = [
  "/",
  "/index.html",
  "/app.css",
  "/app.js",
  "/manifest.webmanifest",
  "/shared/homeDashboardModel.js",
  "/shared/serverViewModel.js",
  "/icons/192.png",
  "/icons/512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // The API and the certificate download always go to the network.
  if (url.pathname.startsWith("/api/") || url.pathname === "/anxos-local-ca.crt") return;
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!SHELL.includes(path) && !SHELL.includes(url.pathname)) return;
  // Network first, so an updated AnxOS serves its updated app; the cached
  // copy is only for when the computer can't be reached.
  event.respondWith(fetch(event.request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(path, copy));
      }
      return response;
    })
    .catch(() => caches.match(path).then((cached) => cached || Response.error())));
});
