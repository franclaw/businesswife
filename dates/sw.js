/* Date Picker service worker — see /components/sw-core.js. */
self.BW_SW = {
  cache: "bw-dates-v6",
  scope: "/dates/",
  shell: "/dates/index.html",
  precache: [
    "/dates/index.html",
    "/dates/manifest.webmanifest",
    "/dates/icons/icon-192.png",
    "/dates/icons/icon-512.png",
    "/favicon.png",
  ],
};
importScripts("/components/sw-core.js");
