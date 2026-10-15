/* Planning Poker service worker — see /components/sw-core.js. */
self.BW_SW = {
  cache: "bw-poker-v3",
  scope: "/planning-poker/",
  shell: "/planning-poker/index.html",
  precache: [
    "/planning-poker/index.html",
    "/planning-poker/app.css",
    "/planning-poker/app.js",
    "/planning-poker/manifest.webmanifest",
    "/planning-poker/icons/icon-192.png",
    "/planning-poker/icons/icon-512.png",
    "/favicon.png",
    "/apple-touch-icon.png",
  ],
};
importScripts("/components/sw-core.js");
