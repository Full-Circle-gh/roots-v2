// Storefront config cache. Fetched at app launch + on home page focus.
// Holds the entire response from /api/retail/config:
//   { version, theme: {...}, fees: {...}, copy: {...},
//     home: { layout: [...] }, promotions: { layout: [...] }, ... }
// 60-second cache to avoid redundant fetches during a session.
//
// Three layers of resilience, because EVERY page's content hangs off this one
// request — when it fails the customer gets an empty storefront:
//   1. In-flight de-dupe. Launch fires load() from app.js, the home page's
//      onboarding gate, and home.refresh() within ~50ms of each other; without
//      this that's three 48 KB round-trips competing for WeChat's request
//      concurrency budget, and three chances to time out.
//   2. One automatic retry on a network/timeout failure (NOT on a real HTTP
//      error — a 500 won't fix itself in 600ms).
//   3. Last-good copy persisted to storage. A cold launch on a dead network
//      now renders the storefront the customer saw last time instead of
//      "Nothing here yet".

const api = require('./api');

const STORE_KEY = 'config_cache_v1';
// Persisted config older than this is ignored — better an empty state than a
// storefront from a fortnight ago. Only ever used when the network fails.
const STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

let _cache = null;
let _at = 0;
let _inflight = null;
let _hydrated = false;
let _stale = false;      // true when the last load() served a fallback copy
let _persistedVersion = null;   // cfg.version already written to storage
const TTL_MS = 60 * 1000;

// Pull the last-good config off disk once per launch. `_at` stays 0 so the
// TTL check always misses and load() still goes to the network — the hydrated
// copy is only a floor, never a reason to skip a fetch. The sync readers
// (get/layout/copy) benefit immediately: theme colours and copy resolve on the
// first frame instead of after the round-trip.
function hydrate() {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const row = wx.getStorageSync(STORE_KEY);
    if (row && row.data && typeof row.data === 'object'
        && Number.isFinite(row.at) && Date.now() - row.at < STALE_MAX_MS) {
      _cache = row.data;
      _at = 0;
      _persistedVersion = row.data.version;
    }
  } catch (e) { /* storage unavailable — carry on without a floor */ }
}

// Async so a 48 KB write never blocks the frame that's rendering the page.
// cfg.version is the storefront_config high-water mark, so an unchanged
// version means an identical payload — skip the write entirely.
function persist(data) {
  if (!data || data.version === _persistedVersion) return;
  _persistedVersion = data.version;
  try { wx.setStorage({ key: STORE_KEY, data: { at: Date.now(), data }, fail() {} }); }
  catch (e) { /* best-effort */ }
}

// A wx.request that never reached the server (timeout, DNS, radio drop) is
// worth one immediate retry; an HTTP/application error is not.
function isTransient(e) {
  const m = String((e && e.message) || '');
  return m.indexOf('network_') === 0 || m.indexOf('server_error_') === 0;
}

function fetchConfig(path, retry = true) {
  return api.get(path).catch((e) => {
    if (!retry || !isTransient(e)) throw e;
    return new Promise((resolve, reject) => {
      setTimeout(() => fetchConfig(path, false).then(resolve, reject), 600);
    });
  });
}

async function load(force = false) {
  hydrate();
  if (!force && _cache && _at && Date.now() - _at < TTL_MS) return _cache;
  // Two callers landing in the same tick share one round-trip — launch fires
  // load() from app.js and from the home page within ~50ms. A forced caller
  // (pull-to-refresh, a preview-QR swap) always starts its own request: it is
  // asking for data newer than whatever is already on the wire.
  if (_inflight && !force) return _inflight;
  // CMS draft-preview pass-through. When app.globalData.preview.token is
  // populated (set by app.js onLaunch from a preview QR scene or a
  // DevTools custom-compile path), tack `?preview_token=...` onto the
  // config fetch so the backend overlays unpublished draft layouts on
  // top of the live snapshot. Customers with no preview token are
  // completely unaffected.
  let path = '/api/retail/config';
  let isPreview = false;
  try {
    const app = getApp();
    const tok = app?.globalData?.preview?.token;
    if (tok) { path += '?preview_token=' + encodeURIComponent(tok); isPreview = true; }
  } catch {}

  _inflight = fetchConfig(path).then(
    (data) => {
      _inflight = null;
      _cache = data;
      _at = Date.now();
      _stale = false;
      // Never persist a draft overlay — the next cold launch would render
      // unpublished blocks to a customer.
      if (!isPreview) persist(data);
      return data;
    },
    (e) => {
      _inflight = null;
      // Fall back to whatever's cached — this session's copy, or the last-good
      // one off disk. Stale beats blank: without this a single timed-out
      // request on a cold launch leaves the home page with no layout at all.
      if (_cache) { _stale = true; return _cache; }
      throw e;
    },
  );
  return _inflight;
}

// True when the value load() last resolved was a fallback (session cache or
// disk) because the fetch failed. Callers that want to tell the customer
// "you're looking at an older version" — or report it — read this.
function wasStale() { return _stale; }

function layout(page) {
  hydrate();
  return _cache?.[page]?.layout || [];
}

// Synchronous read of a dotted path from the cached config (e.g.
// 'fees.freeShippingThreshold'). Returns `fallback` when config isn't loaded
// yet or the key is missing. Callers that need a fresh value should await
// load() first; this is for render passes that rely on the launch-time cache.
function get(path, fallback) {
  hydrate();
  if (!_cache) return fallback;
  let node = _cache;
  for (const p of String(path).split('.')) node = node?.[p];
  return node == null ? fallback : node;
}

function copy(key, lang) {
  // copy keys are dotted paths like 'copy.cart.empty'. The cached config has
  // them already nested: cfg.copy.cart.empty = { en: '...', cn: '...' }
  hydrate();
  if (!_cache) return '';
  const parts = key.split('.');
  let node = _cache;
  for (const p of parts) node = node?.[p];
  if (!node || typeof node !== 'object') return '';
  return (lang === 'cn' ? node.cn : node.en) || node.en || node.cn || '';
}

module.exports = { load, layout, copy, get, wasStale };
