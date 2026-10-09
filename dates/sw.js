/* Date Picker shell cache — install: Chrome → Install app / Add to Home screen */
const CACHE = "bw-dates-v4";
const PRECACHE = [
  "/dates/",
  "/dates/index.html",
  "/dates/manifest.webmanifest",
  "/dates/icons/icon-192.png",
  "/dates/icons/icon-512.png",
  "/favicon.png",
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
  // Live overlap is never cached — only the shell and its assets.
  if (url.pathname.startsWith("/dates/api/")) return;
  if (!url.pathname.startsWith("/dates/") && url.pathname !== "/favicon.png") return;

  // Pages go network-first so a deploy shows up on the next load; the cached
  // shell is only the offline fallback. Every page route serves the same file,
  // and private edit links must never become cache keys, so pages are stored
  // under /dates/index.html only.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/dates/index.html", copy));
        }
        return res;
      }).catch(() => caches.match("/dates/index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => new Response("", { status: 503, statusText: "Offline" })))
  );
});
