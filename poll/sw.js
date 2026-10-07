/* Poll shell cache — install: Chrome → Install app / Add to Home screen */
const CACHE = "bw-poll-v1";
const PRECACHE = [
  "/poll/",
  "/poll/index.html",
  "/poll/manifest.webmanifest",
  "/poll/icons/icon-192.png",
  "/poll/icons/icon-512.png",
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
  // Live data is never cached — only the shell and its assets.
  if (url.pathname.startsWith("/poll/api/")) return;
  if (!url.pathname.startsWith("/poll/") && url.pathname !== "/favicon.png") return;

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
        if (url.pathname === "/poll/" || url.pathname === "/poll/index.html" || /^\/poll\/[a-z0-9]{6}\/?$/.test(url.pathname)) {
          return caches.match("/poll/index.html");
        }
        return new Response("", { status: 503, statusText: "Offline" });
      });
    })
  );
});
