// One store setting, read from storefront_config by key, with a fallback when
// the row is missing or its JSON will not parse. Moved out of routes/retail.js
// unchanged (decisions §477): settings are read through it from all over the
// retail code, and the loyalty rules need it too.
//
// Below it, the whole-config loader (loadConfig) and the list of key prefixes
// it never returns, moved the same way in a later §477 group. Every public
// and admin config read goes through loadConfig, so PRIVATE_CONFIG_PREFIXES is
// what keeps integration secrets, printer settings, review seeding and the
// kitchen's WeCom link out of GET /api/retail/config
// (scripts/test_public_config_secrets.js section 6 holds that).
'use strict';

const { tdb } = require('./tenant-db');
const { ALLOWED_PAGES, withShowOn } = require('./page-layout');

function cfgValue(key, fallback) {
  const row = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}

// Keys whose prefix is in this set are FILTERED OUT of the public
// /api/retail/config response — they hold third-party API secrets
// (kd100 key, JD app_secret, etc.) and must never reach the mini app.
// 'reviews.topup' is operator-only: publishing it would announce, to anyone
// who opens /api/retail/config, that the store seeds its own reviews.
// 'reviews.reward' is deliberately NOT private — it is an offer to the
// customer, and the mini app reads the amount straight from here.
// `kitchen.` — §432: the kitchen group's WeCom webhook is a licence to post
// into that group, and the public config is served to anyone who asks.
const PRIVATE_CONFIG_PREFIXES = ['integrations.', 'printer.', 'reviews.topup', 'kitchen.'];

function loadConfig() {
  const rows = tdb().prepare('SELECT key, value_json FROM storefront_config').all();
  const out = { version: 0 };
  for (const { key, value_json } of rows) {
    if (PRIVATE_CONFIG_PREFIXES.some(p => key.startsWith(p))) continue;
    let v; try { v = JSON.parse(value_json); } catch { v = value_json; }
    setPath(out, key.split('.'), v);
  }
  const t = tdb().prepare("SELECT COALESCE(MAX(strftime('%s', updated_at)), 0) AS t FROM storefront_config").get();
  out.version = Number(t?.t || 0);
  // Every published page layout leaves here with `show_on` explicit on each
  // block (see SHOW_ON_DEFAULTS), so the mini app and the web shop filter on
  // one value rather than each guessing a type's default.
  for (const page of ALLOWED_PAGES) {
    if (out[page] && Array.isArray(out[page].layout)) out[page].layout = withShowOn(out[page].layout);
  }
  return out;
}
function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (cur[seg] == null || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) cur[seg] = {};
    cur = cur[seg];
  }
  cur[path[path.length - 1]] = value;
}

module.exports = { cfgValue, PRIVATE_CONFIG_PREFIXES, loadConfig, setPath };
