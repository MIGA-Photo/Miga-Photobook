// Miga-Photobook service worker.
//
// Scope: registered as /service-worker.js from the repo root, so its default
// scope is "/" — it controls all three design folders (root, /v2/, /v3/) with
// this single file, no per-design copy needed.
//
// Strategy: network-first, same-origin GET requests only. On every request
// we try the network first and cache a copy of what comes back; if the
// network fails (offline / flaky connection) we fall back to the last cached
// copy. This is deliberately NOT cache-first: this is an e-commerce site
// with live product data, prices, and design-switch config, so we never want
// a visitor served a stale cached version when the network is actually
// available.
//
// The Worker API (miga-photobook-api.magdyfarouk380.workers.dev) is a
// different origin, so it's never intercepted here — product lists, prices,
// admin login/upsert calls, and payment requests always go straight to the
// network untouched. Non-GET requests (POST/PUT/etc, e.g. admin saves) are
// also left untouched.

const CACHE_NAME = 'miga-photobook-v1';

self.addEventListener('install', function (event) {
  // Activate a newly-installed worker immediately instead of waiting for
  // all open tabs of the old version to close.
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) { return name !== CACHE_NAME; })
            .map(function (name) { return caches.delete(name); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;

  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(function (res) {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, resClone); });
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (cached) {
          return cached || Response.error();
        });
      })
  );
});
