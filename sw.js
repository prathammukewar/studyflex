// Offline support. Same-origin requests are served from cache while a
// fresh copy is fetched in the background, so the app opens instantly
// (and on a plane), and picks up a deploy one load later.
// Bump VERSION with any deploy so old caches get swept.

const VERSION = 'studyflex-v8';
const CORE = [
  '.',
  'index.html',
  'css/style.css',
  'vendor/katex.css',
  'vendor/katex.min.js',
  'js/app.js', 'js/fsrs.js', 'js/expr.js', 'js/rng.js', 'js/template.js',
  'js/store.js', 'js/session.js', 'js/fx.js', 'js/ai.js', 'js/gamify.js', 'js/sync.js',
  'js/decks/calc1.js', 'js/decks/techniques.js',
  'manifest.webmanifest',
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== location.origin) return;
  ev.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(ev.request);
      const fresh = fetch(ev.request).then(res => {
        if (res.ok) cache.put(ev.request, res.clone());
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
