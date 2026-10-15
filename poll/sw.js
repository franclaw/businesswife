/* Poll service worker — see /components/sw-core.js. */
self.BW_SW = {
  cache: "bw-poll-v2",
  scope: "/poll/",
  shell: "/poll/index.html",
  precache: [
    "/poll/index.html",
    "/poll/manifest.webmanifest",
    "/poll/icons/icon-192.png",
    "/poll/icons/icon-512.png",
    "/favicon.png",
  ],
};
importScripts("/components/sw-core.js");
