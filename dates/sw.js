/* Date Picker shell cache — install: Chrome → Install app / Add to Home screen */
const CACHE = "bw-dates-v1";
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

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => {
        if (url.pathname === "/dates/" || url.pathname === "/dates/index.html" || /^\/dates\/[a-z0-9]{6}\/?$/.test(url.pathname)) {
          return caches.match("/dates/index.html");
        }
        return new Response("", { status: 503, statusText: "Offline" });
      });
    })
  );
});
