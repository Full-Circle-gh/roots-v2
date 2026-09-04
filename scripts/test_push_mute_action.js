#!/usr/bin/env node
/**
 * The off switch carried by the notification itself (public/sw.js).
 *
 *   node scripts/test_push_mute_action.js
 *
 * No network, no DB. sw.js is a service worker, not a module, so it is read as
 * source and run in a vm against a fake ServiceWorkerGlobalScope — the same
 * technique scripts/test_point_search.js uses for 04-orders.js. Events are
 * dispatched for real and the stubs record what the worker did.
 *
 * Why this exists. A push is delivered to a DEVICE, but every mute we had was
 * attached to an IDENTITY and lived on a page belonging to one login:
 * Profile > Notifications is operator-only (tenant_users), and the two kitchen
 * pages that enrol a device offer Enable and nothing else. A kitchen-realm user
 * reaching retail-admin gets no avatar menu at all, so the notifications they
 * were receiving had no switch anywhere in the product. This button is on the
 * device that is ringing, which is the only surface guaranteed to be reachable.
 *
 * The guarantee under test is the last one: the device unsubscribes EVEN WHEN
 * the server never hears about it (no session, 401, offline). A button that
 * only works when a server call lands is the same class of bug all over again.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/TEST-ENDPOINT-733';

// Build a fresh worker in its own context. `fetchImpl` lets a test play the
// server: signed in, 401, or offline.
function loadSW({ subscribed = true, fetchImpl = null } = {}) {
  const listeners = {};
  const rec = { fetch: [], notifications: [], opened: [], focused: 0, unsubscribed: 0, order: [] };
  let sub = subscribed ? {
    endpoint: ENDPOINT,
    unsubscribe: async () => { rec.unsubscribed++; rec.order.push('unsubscribe'); sub = null; return true; },
  } : null;

  const selfObj = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    skipWaiting: () => {},
    location: { origin: 'https://food.example.com' },
    registration: {
      showNotification: async (title, opts) => { rec.notifications.push({ title, opts }); },
      pushManager: { getSubscription: async () => sub },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => [],
      openWindow: async (u) => { rec.opened.push(u); },
    },
  };

  const ctx = {
    self: selfObj,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    URL, JSON, Promise, setTimeout,
    Response: function Response() {},
    fetch: async (url, init) => {
      rec.fetch.push({ url, init });
      rec.order.push('fetch:' + url);
      if (fetchImpl) return fetchImpl(url, init);
      return { ok: true, status: 200 };
    },
    caches: {
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      keys: async () => [], match: async () => null, delete: async () => {},
    },
  };
  ctx.location = selfObj.location;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'public/sw.js' });
  return { listeners, rec };
}

// Dispatch one event and await whatever the handler passed to waitUntil.
async function dispatch(listeners, type, event) {
  const waits = [];
  event.waitUntil = (p) => waits.push(p);
  for (const fn of (listeners[type] || [])) fn(event);
  await Promise.all(waits);
}

const PUSH_EVENT = () => ({
  data: { json: () => ({
    title: '⏰ Deliver soon · 即将配送',
    body: 'TC000337 · Today 2PM–4PM',
    url: '/retail-admin?tab=orders',
    tag: 'retail-ship-1',
  }) },
});
const clickEvent = (action) => ({
  action: action || '',
  notification: { close: () => {}, data: { url: '/retail-admin?tab=orders' } },
});

function bodyOf(rec, urlPath) {
  const hit = rec.fetch.find(f => f.url === urlPath);
  assert.ok(hit, urlPath + ' was never called');
  return { init: hit.init, body: JSON.parse(hit.init.body) };
}

(async () => {
console.log('\nThe notification carries its own off switch\n');

await it('every rendered push offers the off switch', async () => {
  const { listeners, rec } = loadSW();
  await dispatch(listeners, 'push', PUSH_EVENT());
  assert.strictEqual(rec.notifications.length, 1);
  const actions = rec.notifications[0].opts.actions;
  assert.ok(Array.isArray(actions), 'no actions were declared');
  assert.ok(actions.some(a => a.action === 'roots-mute'), 'the mute action is missing');
  // Declared at show time or it does not exist — a notificationclick handler
  // alone renders no button.
  assert.ok(actions[0].title && /关闭/.test(actions[0].title), 'the button needs a label');
});

await it('the switch tells BOTH realms, because a device can hold either login', async () => {
  const { listeners, rec } = loadSW();
  await dispatch(listeners, 'notificationclick', clickEvent('roots-mute'));
  const kitchen = bodyOf(rec, '/api/push/pref');
  const backend = bodyOf(rec, '/api/backend/push/pref');
  assert.strictEqual(kitchen.body.enabled, false);
  assert.strictEqual(backend.body.enabled, false);
  // Cookies, or the mute lands on nobody.
  assert.strictEqual(kitchen.init.credentials, 'include');
  assert.strictEqual(backend.init.credentials, 'include');
});

await it('the endpoint goes up while it is still alive', async () => {
  const { listeners, rec } = loadSW();
  await dispatch(listeners, 'notificationclick', clickEvent('roots-mute'));
  const backend = bodyOf(rec, '/api/backend/push/pref');
  assert.strictEqual(backend.body.endpoint, ENDPOINT,
    'the backend realm finds the kitchen subscription by endpoint — sending null loses that link');
  assert.strictEqual(rec.order[rec.order.length - 1], 'unsubscribe',
    'unsubscribe must come last; an endpoint killed first cannot be looked up');
});

await it('the device unsubscribes itself', async () => {
  const { listeners, rec } = loadSW();
  await dispatch(listeners, 'notificationclick', clickEvent('roots-mute'));
  assert.strictEqual(rec.unsubscribed, 1);
});

await it('and unsubscribes even when NOBODY is signed in (401 from both realms)', async () => {
  const { listeners, rec } = loadSW({ fetchImpl: async () => ({ ok: false, status: 401 }) });
  await dispatch(listeners, 'notificationclick', clickEvent('roots-mute'));
  assert.strictEqual(rec.unsubscribed, 1,
    'this is the whole guarantee: an unsubscribed endpoint cannot be pushed to');
});

await it('and when the network is gone entirely', async () => {
  const { listeners, rec } = loadSW({ fetchImpl: async () => { throw new Error('offline'); } });
  await dispatch(listeners, 'notificationclick', clickEvent('roots-mute'));
  assert.strictEqual(rec.unsubscribed, 1, 'a thrown fetch must not skip the unsubscribe');
});

await it('a device with no subscription left still records the intent', async () => {
  const { listeners, rec } = loadSW({ subscribed: false });
  await dispatch(listeners, 'notificationclick', clickEvent('roots-mute'));
  assert.strictEqual(bodyOf(rec, '/api/push/pref').body.enabled, false);
  assert.strictEqual(bodyOf(rec, '/api/backend/push/pref').body.endpoint, null);
  assert.strictEqual(rec.unsubscribed, 0);
});

await it('the switch confirms itself, so the button is not silent', async () => {
  const { listeners, rec } = loadSW();
  await dispatch(listeners, 'notificationclick', clickEvent('roots-mute'));
  assert.strictEqual(rec.notifications.length, 1);
  assert.match(rec.notifications[0].title, /Notifications off/);
});

await it('turning off never navigates', async () => {
  const { listeners, rec } = loadSW();
  await dispatch(listeners, 'notificationclick', clickEvent('roots-mute'));
  assert.strictEqual(rec.opened.length, 0, 'the point of the button is to leave, not to open the app');
});

await it('an ordinary click still opens the order, and mutes nothing', async () => {
  const { listeners, rec } = loadSW();
  await dispatch(listeners, 'notificationclick', clickEvent(''));
  assert.deepStrictEqual(rec.opened, ['/retail-admin?tab=orders']);
  assert.strictEqual(rec.fetch.length, 0, 'a plain click must never switch notifications off');
  assert.strictEqual(rec.unsubscribed, 0);
});

// THE CACHE NAME IS STAMPED AT DEPLOY, NOT HAND-INCREMENTED. This asserted a
// `vNNN` number until deploy-apply.sh took the job over — the hand-edited number
// was forgotten, collided across parallel branches six times in one day, and
// never reached a browser because the installer overwrote it anyway. So the rule
// this keeps is the one that still has to hold: the name in the repo is the
// sentinel the stamp replaces, and the activate handler evicts by name — a
// worker that kept a constant name would serve the previous build's assets on
// the first load after every deploy.
await it('the shell cache name is the deploy sentinel, and eviction is by name', async () => {
  assert.match(SRC, /const CACHE = 'roots-v2-shell-(?:unstamped|[\w.-]+)'/,
    'CACHE is not the sentinel deploy-apply.sh rewrites');
  assert.match(SRC, /caches\.delete\(/, 'the activate handler no longer evicts old caches');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})();
