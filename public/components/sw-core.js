/* Shared service worker core for every Business Wife app.
 *
 * An app's sw.js sets self.BW_SW = { cache, scope, shell, precache } and then
 * importScripts("/components/sw-core.js").
 *
 * - Live data (/api/, SSE) is never touched.
 * - Pages, scripts and styles are network-first, so a deploy shows up on the
 *   next load; the cache is only the offline fallback. Every page route serves
 *   the same file, and private links must never become cache keys, so pages
 *   are stored under the app's shell path only.
 * - Images are cache-first: they rarely change and are the bulk of the bytes.
 */
(function () {
  const cfg = self.BW_SW;
  const SHARED = ["/components/", "/img/", "/favicon.png", "/favicon.ico", "/apple-touch-icon.png"];

  self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(cfg.cache).then((c) => c.addAll(cfg.precache)).then(() => self.skipWaiting()));
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.filter((k) => k.startsWith(cfg.cache.replace(/-v\d+$/, "-")) && k !== cfg.cache).map((k) => caches.delete(k))))
        .then(() => self.clients.claim())
    );
  });

  function store(key, res) {
    if (res.ok) {
      const copy = res.clone();
      caches.open(cfg.cache).then((c) => c.put(key, copy));
    }
    return res;
  }

  const offline = () => new Response("", { status: 503, statusText: "Offline" });

  self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    const path = url.pathname;
    if (path.includes("/api/")) return;
    const ours = path.startsWith(cfg.scope) || SHARED.some((p) => path.startsWith(p));
    if (!ours) return;

    if (req.mode === "navigate") {
      event.respondWith(
        fetch(req).then((res) => store(cfg.shell, res)).catch(() => caches.match(cfg.shell).then((hit) => hit || offline()))
      );
      return;
    }

    if (/\.(png|jpe?g|webp|ico)$/i.test(path)) {
      event.respondWith(
        caches.match(req).then((hit) => hit || fetch(req).then((res) => store(req, res)).catch(offline))
      );
      return;
    }

    event.respondWith(
      fetch(req).then((res) => store(req, res)).catch(() => caches.match(req).then((hit) => hit || offline()))
    );
  });
})();
