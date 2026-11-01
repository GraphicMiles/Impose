/* Impose app shell cache.
   Navigations are network first with a cache fallback, so a deploy reaches
   users on their next load. The shell is one self-contained document plus
   icons, so the precache is short and cannot drift: every entry here exists
   in the repo. Bump CACHE whenever index.html ships. */

var CACHE = "impose-shell-v77";
var SHELL = "./index.html";
var PRECACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.png",
  "./icon-apple.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(PRECACHE);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === CACHE ? null : caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: always try the network, fall back to the cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then(function (response) {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put(SHELL, copy); });
        return response;
      }).catch(function () {
        return caches.match(SHELL).then(function (hit) {
          return hit || caches.match("./index.html");
        });
      })
    );
    return;
  }

  // Static shell assets: cache first, refreshed in the background.
  event.respondWith(
    caches.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      });
    })
  );
});
