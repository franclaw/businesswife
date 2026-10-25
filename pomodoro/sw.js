/* Pomodoro service worker — see /components/sw-core.js.
 *
 * Until October 2026 Pomodoro had its own cache-first worker ("bw-pomodoro-v1")
 * that served index.html from cache forever. sw-core's activate step deletes
 * every older "bw-pomodoro-*" cache, so installed clients move to the shared
 * network-first behaviour on their next visit. */
self.BW_SW = {
  cache: "bw-pomodoro-v2",
  scope: "/pomodoro/",
  shell: "/pomodoro/index.html",
  precache: [
    "/pomodoro/index.html",
    "/pomodoro/manifest.webmanifest",
    "/pomodoro/icons/icon-192.png",
    "/pomodoro/icons/icon-512.png",
    "/components/theme.css",
    "/favicon.png",
  ],
};
importScripts("/components/sw-core.js");
