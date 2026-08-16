/* Let's Connect - service worker.
 *
 * ---------------------------------------------------------------------------
 * STRATEGY: NETWORK-FIRST, deliberately.
 * ---------------------------------------------------------------------------
 * The usual PWA advice is cache-first for the app shell, and it is the wrong
 * call here. A cache-first shell means a deploy is invisible until the cache
 * happens to expire - which is the same failure this stack has hit repeatedly
 * with a plain browser cache, except a service worker makes it far stickier and
 * far harder to clear from a phone.
 *
 * So: always try the network, fall back to the cache when offline. The cache
 * exists to keep the app usable on a bad connection, not to save a round trip.
 * The cost is one request per asset per load; the benefit is that what you see
 * is always what was last deployed.
 *
 * There is deliberately NO version constant in this file. The cache is a
 * fallback that is overwritten on every successful fetch, so it cannot go
 * stale, and there is no third place to remember to bump alongside
 * package.json and APP_VERSION.
 */

const CACHE = 'lets-connect-v1';

const SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll fails the whole install if any single request fails, which would
      // leave the app with no offline fallback at all. Fetch individually.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/**
 * app.js and styles.css are requested with a ?v=<timestamp> buster, so every
 * load is a unique URL. Strip the query before using it as a cache key, or the
 * cache grows without bound and never serves a hit.
 */
function cacheKeyFor(request) {
  const url = new URL(request.url);
  url.search = '';
  return new Request(url.toString(), { method: 'GET' });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle our own origin. Cross-origin (the webfont) is left to the
  // browser - an opaque response in the cache tells us nothing useful.
  if (url.origin !== self.location.origin) return;

  /**
   * The admin area is not ours.
   *
   * This worker is registered from the couple app at scope "/", which means it
   * also controls /admin/ - and /admin/index.html says in as many words that it
   * deliberately has no service worker. Until now that was an intention rather
   * than a fact: every admin request was already going through here.
   *
   * Found by watching the admin's own network log, where every GET to /api/ came
   * back 503 "You are offline" from the branch below while POSTs (which this
   * worker never sees) went through fine. Whatever made fetch() fail inside the
   * worker there, the admin has no business depending on a worker installed by a
   * different app, and offline caching is meaningless for it anyway.
   */
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;

  // The API is never cached. An answer served from cache would show a couple
  // stale progress, and a cached login response would be worse.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(JSON.stringify({ error: 'You are offline. Reconnect and try again.' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
    return;
  }

  // Navigations: network first, cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('/').then((hit) => hit || Response.error()))
    );
    return;
  }

  // Everything else: network first, refresh the cache, fall back when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(cacheKeyFor(request), copy))
            .catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(cacheKeyFor(request)).then((hit) => hit || Response.error()))
  );
});
