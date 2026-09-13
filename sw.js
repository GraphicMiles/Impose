/* Impose app shell cache.
   Strategy: navigations and the core code files are NETWORK FIRST with a
   cache fallback, so a deploy always reaches users on their next load and
   old JS never runs against new HTML. Everything else (vendored libraries,
   icons, images) is STALE WHILE REVALIDATE: instant from cache, refreshed
   behind the cache's back for next time. */

var CACHE = "impose-shell-v4";
var CORE = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./agent/trace.js",
  "./agent/harness.js",
  "./agent/features.js"
];

/* The full precache list: core files plus the assets that rarely change. */
var PRECACHE = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./agent/trace.js",
  "./agent/harness.js",
  "./agent/features.js",
  "./agent/trace.css",
  "./lucide.min.js",
  "./anime.min.js",
  "./og-image.jpg",
  "./manifest.json",
  "./favicon-64.png",
  "./icon-apple.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    /* Precache one at a time; a single 404 (an icon not yet deployed, say)
       must not abort the whole install. */
    return Promise.all(PRECACHE.map(function (url) {
      return c.add(new Request(url, { cache: "reload" })).catch(function () { /* skip */ });
    }));
  }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k !== CACHE;
    }).map(function (k) {
      return caches.delete(k);
    }));
  }).then(function () {
    return self.clients.claim();
  }));
});

/* The page can ask the new worker to take over immediately after an update:
   postMessage("impose-skip-waiting") from the client, or just reload. */
self.addEventListener("message", function (e) {
  if (e.data === "impose-skip-waiting" && self.skipWaiting) self.skipWaiting();
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  /* Navigations: network first, cached shell when offline. */
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put("./index.html", copy); });
      return res;
    }).catch(function () {
      return caches.match("./index.html");
    }));
    return;
  }

  /* Keep subdirectories when comparing with CORE. Reducing every URL to its
     basename turned agent/features.js into ./features.js, so agent updates
     were accidentally served stale for one load after every deploy. */
  var scopePath = new URL(self.registration.scope).pathname;
  var relative = url.pathname.indexOf(scopePath) === 0
    ? url.pathname.slice(scopePath.length) : url.pathname.replace(/^\/+/, "");
  var path = "./" + relative;
  var isCore = CORE.indexOf(path) !== -1;

  if (isCore) {
    /* Core code: try the network so deploys land, fall back to cache when
       offline. */
    e.respondWith(fetch(e.request).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || caches.match("./index.html");
      });
    }));
    return;
  }

  /* Everything else: serve from cache now, refresh quietly for next time. */
  e.respondWith(caches.match(e.request).then(function (hit) {
    var net = fetch(e.request).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () { return hit; });
    return hit || net;
  }));
});
