#!/usr/bin/env node
/**
 * The installed shell does not wait on a slow network (public/sw.js).
 *
 *   node scripts/test_sw_slow_shell.js
 *
 * No network, no DB. sw.js is run in a vm against a fake worker scope, the same
 * way scripts/test_push_mute_action.js does it, and real fetch events are
 * dispatched at it. The wait is shortened from SHELL_WAIT_MS to 40ms so the
 * suite stays fast; the test first checks the real value is still there.
 *
 * Why this exists. HTML was network-first with no time limit, so the installed
 * phone app sat on the OS splash for as long as a slow connection took. A weak
 * signal or a VPN does not fail a request, it only takes its time, so the
 * saved copy was never reached. Reported 2026-10-01: "stuck here, a lot".
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

const RAW = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const WAIT = 40;
const SRC = RAW.replace(/const SHELL_WAIT_MS = \d+;/, `const SHELL_WAIT_MS = ${WAIT};`);
const ORIGIN = 'https://store.example.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A cache that matches the way the Cache API does: full URL, or the URL less
// its query when asked to ignoreSearch.
function fakeCaches(seed) {
  const store = new Map(Object.entries(seed || {}).map(([u, body]) => [ORIGIN + u, body]));
  const key = (r) => (typeof r === 'string' ? (r.startsWith('/') ? ORIGIN + r : r) : r.url);
  const match = async (r, opts) => {
    const k = key(r);
    if (store.has(k)) return new Response(store.get(k), { status: 200 });
    if (opts && opts.ignoreSearch) {
      const bare = k.split('?')[0];
      for (const [u, body] of store) if (u.split('?')[0] === bare) return new Response(body, { status: 200 });
    }
    return undefined;
  };
  const cache = {
    addAll: async () => {},
    put: async (r, res) => { store.set(key(r), await res.text()); },
    match,
  };
  return { store, api: { open: async () => cache, match, keys: async () => [], delete: async () => true } };
}

// `network(url)` plays the server: return a Response, throw, or never settle.
function loadSW({ saved, network }) {
  const listeners = {};
  const c = fakeCaches(saved);
  const ctx = {
    self: {
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
      skipWaiting: () => {}, location: { origin: ORIGIN },
      registration: { showNotification: async () => {}, pushManager: { getSubscription: async () => null } },
      clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    URL, JSON, Promise, setTimeout, clearTimeout, Response,
    fetch: async (req) => network(req.url),
    caches: c.api,
  };
  ctx.location = ctx.self.location;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  // Dispatch a navigation. Resolves to { res, ms, done } where done settles
  // when every waitUntil has.
  async function navigate(p) {
    const lifetimes = [];
    let responded = null;
    const ev = {
      request: { url: ORIGIN + p, method: 'GET', mode: 'navigate', headers: { get: () => 'text/html' } },
      respondWith: (pr) => { responded = Promise.resolve(pr); },
      waitUntil: (pr) => { lifetimes.push(pr); },
    };
    const t0 = Date.now();
    for (const fn of listeners.fetch) fn(ev);
    assert.ok(responded, 'the worker did not answer the navigation');
    const res = await responded;
    return { res, ms: Date.now() - t0, done: Promise.all(lifetimes) };
  }
  return { navigate, store: c.store };
}

const never = () => new Promise(() => {});
const page = (body, status = 200) => async () => new Response(body, { status });
const slowPage = (body, ms) => async () => { await sleep(ms); return new Response(body, { status: 200 }); };

(async () => {
  console.log('\nsw.js — the installed shell does not hang on a slow network');

  await it('the real wait is 3 seconds, and the shell list still has /m and /login', async () => {
    assert.ok(/const SHELL_WAIT_MS = 3000;/.test(RAW), 'SHELL_WAIT_MS is no longer 3000 — update this test on purpose');
    assert.ok(RAW.includes("const SHELL = ['/login', '/m',"), 'SHELL no longer starts with /login and /m');
  });

  await it('a network that never answers opens the saved copy after the wait', async () => {
    const sw = loadSW({ saved: { '/m': 'SAVED' }, network: never });
    const { res, ms } = await sw.navigate('/m');
    assert.strictEqual(await res.text(), 'SAVED');
    assert.ok(ms >= WAIT - 5 && ms < WAIT + 400, `answered after ${ms}ms`);
  });

  await it('the installed start URL /m?from=app finds the precached /m', async () => {
    const sw = loadSW({ saved: { '/m': 'SAVED' }, network: never });
    const { res } = await sw.navigate('/m?from=app&to=orders');
    assert.strictEqual(await res.text(), 'SAVED');
  });

  await it('a quick network answer wins, and replaces the saved copy', async () => {
    const sw = loadSW({ saved: { '/m': 'OLD' }, network: page('FRESH') });
    const { res, done } = await sw.navigate('/m');
    assert.strictEqual(await res.text(), 'FRESH');
    await done;
    assert.strictEqual(sw.store.get(ORIGIN + '/m'), 'FRESH');
  });

  await it('a late answer still lands in the saved copy for next time', async () => {
    const sw = loadSW({ saved: { '/m?from=app': 'OLD' }, network: slowPage('NEW', WAIT * 3) });
    const { res, done } = await sw.navigate('/m?from=app');
    assert.strictEqual(await res.text(), 'OLD');
    await done;
    assert.strictEqual(sw.store.get(ORIGIN + '/m?from=app'), 'NEW');
  });

  await it('a server error (mid-restart) opens the saved copy and is not saved', async () => {
    const sw = loadSW({ saved: { '/m': 'SAVED' }, network: page('Bad Gateway', 502) });
    const { res, done } = await sw.navigate('/m');
    assert.strictEqual(await res.text(), 'SAVED');
    await done;
    assert.strictEqual(sw.store.get(ORIGIN + '/m'), 'SAVED');
  });

  await it('a 404 is passed through, not hidden behind the saved copy', async () => {
    const sw = loadSW({ saved: { '/m': 'SAVED' }, network: page('Not found', 404) });
    const { res } = await sw.navigate('/m');
    assert.strictEqual(res.status, 404);
  });

  await it('with no saved copy it waits for the network as long as it takes', async () => {
    const sw = loadSW({ saved: {}, network: slowPage('FRESH', WAIT * 3) });
    const { res, ms } = await sw.navigate('/m');
    assert.strictEqual(await res.text(), 'FRESH');
    assert.ok(ms >= WAIT * 3 - 5, `gave up after ${ms}ms`);
  });

  await it('with no saved copy and no network it says Offline', async () => {
    const sw = loadSW({ saved: {}, network: async () => { throw new TypeError('Failed to fetch'); } });
    const { res } = await sw.navigate('/m');
    assert.strictEqual(res.status, 503);
  });

  await it('a page outside the shell is unchanged: it waits for the network', async () => {
    const sw = loadSW({ saved: { '/cms': 'SAVED-CMS' }, network: slowPage('FRESH-CMS', WAIT * 3) });
    const { res, ms } = await sw.navigate('/cms?desktop=1');
    assert.strictEqual(await res.text(), 'FRESH-CMS');
    assert.ok(ms >= WAIT * 3 - 5, `answered after ${ms}ms`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
