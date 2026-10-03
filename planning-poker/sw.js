/* Planning Poker shell cache. API/SSE are network-only. */
const CACHE = "bw-poker-v2";
const PRECACHE = [
  "/planning-poker/",
  "/planning-poker/index.html",
  "/planning-poker/manifest.webmanifest",
  "/planning-poker/icons/icon-192.png",
  "/planning-poker/icons/icon-512.png",
  "/favicon.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API or SSE
  if (url.pathname.includes("/api/")) return;

  const path = url.pathname;
  const isShell =
    path === "/planning-poker" ||
    path === "/planning-poker/" ||
    path === "/planning-poker/index.html" ||
    path.startsWith("/planning-poker/icons/") ||
    path === "/planning-poker/manifest.webmanifest" ||
    path === "/planning-poker/sw.js" ||
    path.startsWith("/planning-poker/r/") ||
    path.startsWith("/img/") ||
    path === "/favicon.png" ||
    path === "/favicon.ico" ||
    path === "/apple-touch-icon.png";

  if (!isShell) return;

  // Lobby style query must not be served from the precached default shell.
  if ((path === "/planning-poker" || path === "/planning-poker/" || path === "/planning-poker/index.html") && url.searchParams.has("lobby")) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match("/planning-poker/index.html")))
    );
    return;
  }

  // Room pages: network first, fall back to shell HTML for offline lobby UX
  if (/^\/planning-poker\/r\//.test(path)) {
    event.respondWith(
      fetch(req).catch(() => caches.match("/planning-poker/index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      // Map /planning-poker to cached index
      if (path === "/planning-poker" || path === "/planning-poker/") {
        return caches.match("/planning-poker/index.html").then((h) => h || fetch(req));
      }
      return fetch(req).then((res) => {
        if (res.ok && (path.startsWith("/planning-poker/") || path.startsWith("/img/") || path.startsWith("/favicon") || path === "/apple-touch-icon.png")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match("/planning-poker/index.html"));
    })
  );
});
