// Roots v2 — minimal service worker.
// Strategy:
//   • HTML pages (/, /pos, /kitchen, /login):  NETWORK-FIRST. Always try
//     to get the freshest shell. Fall back to cache only when offline.
//     This is what was missing in earlier versions — a stale cached
//     /pos.html could outlive a route fix and silently break PWA install.
//   • Web manifests + icons + JS/CSS/etc.: stale-while-revalidate
//     (instant from cache, refresh in background).
//   • API requests: network-only, never cached.
//
// Bump CACHE on every UI shape change to force every client to evict
// its old shell on next load (activate handler deletes all old caches).
const CACHE = 'roots-v2-shell-v410-stock-activity-in-products';
const SHELL = ['/', '/login'];

// Heuristic — request that wants HTML?
function isHTMLRequest(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return true;
  return false;
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Drop every cache that isn't the current one — old shells go away.
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    // Tell every connected page that a new shell is live so they reload
    // and pick up the latest HTML/JS without the user having to think
    // about it. The page-side handler is in pos.html / kitchen.html.
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) {
      try { c.postMessage({ type: 'sw-updated' }); } catch {}
    }
  })());
});

// ─── Web Push handlers ───────────────────────────────────────────
// Server fires a push to the user's subscription endpoint; the OS
// wakes the service worker and dispatches 'push'. We render a native
// notification; clicking it focuses an existing tab (or opens one).
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Roots', body: e.data ? e.data.text() : '' }; }
  const title = data.title || '🌿 Roots';
  const body  = data.body  || '';
  const url   = data.url   || '/';
  const tag   = data.tag   || 'roots-' + Date.now();
  e.waitUntil(self.registration.showNotification(title, {
    body, tag, icon: '/pos-icon-192.png', badge: '/pos-icon-192.png',
    data: { url },
    requireInteraction: !!data.requireInteraction,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse an existing tab on the same origin if possible.
    for (const w of wins) {
      try {
        const u = new URL(w.url);
        if (u.origin === self.location.origin) {
          await w.focus();
          if (w.url.replace(u.origin, '') !== url) {
            try { w.navigate(url); } catch { /* fallback */ }
          }
          return;
        }
      } catch {}
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API: always network, never cached.
  if (url.pathname.startsWith('/api/')) return;
  // Only handle GETs.
  if (e.request.method !== 'GET') return;
  // Same-origin only — third-party CDNs (polyfill, fonts) bypass us.
  if (url.origin !== location.origin) return;

  // HTML — network-first. The cache is just a backup for offline.
  if (isHTMLRequest(e.request)) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(e.request);
        if (fresh && fresh.ok) {
          // Cache the latest copy in case the user goes offline next.
          const clone = fresh.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return fresh;
      } catch {
        const cached = await caches.match(e.request);
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // Non-HTML assets — stale-while-revalidate.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
