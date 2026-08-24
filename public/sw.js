// Roots v2 — minimal service worker.
// Strategy:
//   • HTML pages (/, /kitchen, /stock, /login, /m):  NETWORK-FIRST, on a
//     deadline. Always try for the freshest shell — a stale cached shell
//     outliving a route fix is what silently broke PWA install in earlier
//     versions. But "network-first" cannot mean "wait forever": a network
//     that hangs rather than fails leaves an installed app on its splash
//     screen indefinitely, so past HTML_NET_TIMEOUT_MS we open from cache
//     and keep the fetch running to freshen it. See htmlResponse().
//   • Web manifests + icons + JS/CSS/etc.: stale-while-revalidate
//     (instant from cache, refresh in background).
//   • API requests: network-only, never cached.
//
// Bump CACHE on every UI shape change to force every client to evict
// its old shell on next load (activate handler deletes all old caches).
const CACHE = 'roots-v2-shell-v834-mobile-launch';
// '/m' is Tacet Mobile — the phone companion, and the one shell here that is
// meant to be INSTALLED rather than visited. An installed app that opens to a
// browser error the first time the signal drops is not an app, so its shell is
// pre-cached with the others.
const SHELL = ['/', '/login', '/m'];

// Heuristic — request that wants HTML?
function isHTMLRequest(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return true;
  return false;
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // One add() per URL rather than addAll(): addAll is all-or-nothing, so a
    // single route answering badly mid-deploy rejects the whole install, the
    // new worker never activates, and every phone quietly stays on the old
    // shell with no sign that anything went wrong.
    await Promise.all(SHELL.map(u => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Drop every cache that isn't the current one — old shells go away.
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    // Tell every connected page that a new shell is live so they reload
    // and pick up the latest HTML/JS without the user having to think
    // about it. The page-side handler is in kitchen.html.
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) {
      try { c.postMessage({ type: 'sw-updated' }); } catch {}
    }
  })());
});

// ─── The off switch ──────────────────────────────────────────────
// A device can carry a kitchen login (push_subscriptions), a backend operator
// login (tenant_operator_push_subs), or both — unrelated sessions sharing one
// service worker and therefore one push endpoint. This code cannot know which,
// so it tells both realms. The one that isn't signed in answers 401 and no-ops.
const MUTE_ACTION = 'roots-mute';

function _postJSON(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  }).catch(() => null);
}

// Switch this device off: record the intent server-side wherever a session
// allows it, then drop the browser subscription regardless.
async function muteThisDevice() {
  let sub = null;
  try { sub = await self.registration.pushManager.getSubscription(); } catch (e) { sub = null; }
  const endpoint = sub ? sub.endpoint : null;
  // The endpoint goes up BEFORE the unsubscribe below — the backend realm uses
  // it to find the kitchen subscription that shares this browser.
  await Promise.all([
    _postJSON('/api/push/pref', { enabled: false }),
    _postJSON('/api/backend/push/pref', { enabled: false, endpoint }),
  ]);
  // The belt, and the reason the button can be trusted: an unsubscribed
  // endpoint cannot be pushed to whatever the server still believes. Any row
  // still pointing at it is pruned on the next send's 410 (routes/push.js).
  if (sub) { try { await sub.unsubscribe(); } catch (e) {} }
  try {
    await self.registration.showNotification('Notifications off · 通知已关闭', {
      body: 'This device stops here. Switch them back on in the app. · 此设备将不再收到推送，可在应用内重新开启。',
      tag: 'roots-muted', icon: '/pos-icon-192.png', badge: '/pos-icon-192.png',
    });
  } catch (e) {}
}

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
  // NOTE: "pos-icon-192" is the notification artwork, not a POS reference.
  // The POS shell was removed but this icon is still the live push icon
  // and badge for every notification (same asset used by app.html).
  e.waitUntil(self.registration.showNotification(title, {
    body, tag, icon: '/pos-icon-192.png', badge: '/pos-icon-192.png',
    // The off switch travels WITH the notification. Every other one lives on a
    // page tied to a single login — Profile > Notifications is operator-only,
    // and the kitchen pages offer Enable and nothing else — so whoever a push
    // actually reaches may have no surface that can switch it off. This button
    // sits on the device that is ringing, which is the only place that is
    // always true. Browsers without action support ignore the key.
    actions: [{ action: MUTE_ACTION, title: 'Turn off · 关闭' }],
    // When a new push reuses an existing tag the browser replaces the tray
    // entry *silently* unless renotify is set — that's why only the first
    // push banners/chimes and later ones just update quietly. renotify makes
    // every push re-alert. It requires a tag, so only set it when we have one.
    renotify: !!tag,
    data: { url },
    requireInteraction: !!data.requireInteraction,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // "Turn off" — never navigate; the whole point of the button is to leave.
  if (e.action === MUTE_ACTION) { e.waitUntil(muteThisDevice()); return; }
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

// ─── Opening the app ─────────────────────────────────────────────
// How long a navigation waits for the network before it opens from cache
// instead. This number is the difference between an app and a splash screen.
//
// fetch() does not reject on a network that has simply stopped answering. A
// phone on a VPN that has dropped, or a bar of signal that is really none,
// leaves the promise pending for as long as the OS allows — minutes. Until it
// settles the navigation has no response, nothing paints, and an installed app
// sits on its launch icon with no address bar to retry from and nothing to tap.
// The shell needed to draw that app was in the cache the whole time.
//
// Four seconds is longer than any healthy launch and shorter than anyone's
// patience. Past it we open from the shell we already have and leave the fetch
// running, so the cache is current again for the launch after this one.
const HTML_NET_TIMEOUT_MS = 4000;

// A SHELL path is served from a file, identically, whatever query string it is
// asked for with — server.js hands '/m' the same m.html every time, and the
// '?from=' and '?to=' the app launches with are read by the page's own script,
// never by the server. Only for those paths is one cache entry per path the
// right answer; anywhere else a query string may well pick the page, and
// serving a neighbouring variant would be worse than serving nothing.
const SHELL_PATHS = new Set(SHELL);

// The cached shell for a request, past the query string when the path allows.
//
// This is the difference between the pre-cached shell working and merely
// existing. SHELL stores '/m', but the installed app's start_url is
// '/m?from=app' and its home-screen shortcuts add '&to=orders' — an exact
// match misses every one of them, so the shell that '/m' is in SHELL to
// provide would never once be found on a real launch.
function cachedShell(request) {
  const path = new URL(request.url).pathname;
  return caches.match(request, { ignoreSearch: SHELL_PATHS.has(path) });
}

// Cache a page under the same key cachedShell() will look for: the bare path
// for a shell, so one entry serves every launch variant instead of the cache
// growing a copy of a 500KB file per shortcut; the full URL for anything else.
function cacheHTML(url, response) {
  const key = SHELL_PATHS.has(url.pathname) ? url.pathname : url.href;
  const clone = response.clone();
  return caches.open(CACHE).then(c => c.put(key, clone)).catch(() => {});
}

async function htmlResponse(e) {
  const url = new URL(e.request.url);
  const net = fetch(e.request).then((res) => {
    if (res && res.ok) cacheHTML(url, res);
    return res;
  });
  // Keep the worker alive for the refresh even when the race below has already
  // answered from cache and the response is long since delivered.
  const settled = net.catch(() => null);
  e.waitUntil(settled);

  const cached = await cachedShell(e.request);
  // Nothing to fall back to — a first visit, or a page outside the shell.
  // Waiting for the network is the only option worth having.
  if (!cached) {
    const res = await settled;
    return res || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
  // Give the network its deadline. Whatever it says inside that window wins,
  // errors included: a 500 from a bad deploy is news, and papering over it with
  // yesterday's shell would hide it. Silence is the only thing we override.
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(() => r(null), HTML_NET_TIMEOUT_MS); });
  const won = await Promise.race([settled, deadline]);
  clearTimeout(timer);
  return won || cached;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API: always network, never cached.
  if (url.pathname.startsWith('/api/')) return;
  // The shared cost formula: network only. The server sends it no-store; this
  // is the belt to that pair of braces. A cached money formula would go on
  // disagreeing with the server until the cache was evicted.
  if (url.pathname === '/lib/ingredient-cost.js') return;
  // Only handle GETs.
  if (e.request.method !== 'GET') return;
  // Same-origin only — third-party CDNs (polyfill, fonts) bypass us.
  if (url.origin !== location.origin) return;

  // HTML — network-first, with a deadline. See htmlResponse().
  if (isHTMLRequest(e.request)) {
    e.respondWith(htmlResponse(e));
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
