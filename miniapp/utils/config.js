// Storefront config cache. Fetched at app launch + on home page focus.
// Holds the entire response from /api/retail/config:
//   { version, theme: {...}, fees: {...}, copy: {...},
//     home: { layout: [...] }, promotions: { layout: [...] }, ... }
// 60-second cache to avoid redundant fetches during a session.

const api = require('./api');

let _cache = null;
let _at = 0;
const TTL_MS = 60 * 1000;

async function load(force = false) {
  if (!force && _cache && Date.now() - _at < TTL_MS) return _cache;
  // CMS draft-preview pass-through. When app.globalData.preview.token is
  // populated (set by app.js onLaunch from a preview QR scene or a
  // DevTools custom-compile path), tack `?preview_token=...` onto the
  // config fetch so the backend overlays unpublished draft layouts on
  // top of the live snapshot. Customers with no preview token are
  // completely unaffected.
  let path = '/api/retail/config';
  try {
    const app = getApp();
    const tok = app?.globalData?.preview?.token;
    if (tok) path += '?preview_token=' + encodeURIComponent(tok);
  } catch {}
  try {
    const data = await api.get(path);
    _cache = data;
    _at = Date.now();
    return data;
  } catch (e) {
    // Fall back to whatever's cached, even if stale
    if (_cache) return _cache;
    throw e;
  }
}

function layout(page) {
  return _cache?.[page]?.layout || [];
}

function copy(key, lang) {
  // copy keys are dotted paths like 'copy.cart.empty'. The cached config has
  // them already nested: cfg.copy.cart.empty = { en: '...', cn: '...' }
  if (!_cache) return '';
  const parts = key.split('.');
  let node = _cache;
  for (const p of parts) node = node?.[p];
  if (!node || typeof node !== 'object') return '';
  return (lang === 'cn' ? node.cn : node.en) || node.en || node.cn || '';
}

module.exports = { load, layout, copy };
