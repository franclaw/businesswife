/* Date Picker service worker — see /components/sw-core.js. */
self.BW_SW = {
  cache: "bw-dates-v7",
  scope: "/dates/",
  shell: "/dates/index.html",
  precache: [
    "/dates/index.html",
    "/dates/manifest.webmanifest",
    "/dates/icons/icon-192.png",
    "/dates/icons/icon-512.png",
    "/components/theme.css",
    "/favicon.png",
  ],
};
importScripts("/components/sw-core.js");
