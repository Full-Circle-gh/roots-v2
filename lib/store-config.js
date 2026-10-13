// One store setting, read from storefront_config by key, with a fallback when
// the row is missing or its JSON will not parse. Moved out of routes/retail.js
// unchanged (decisions §477): settings are read through it from all over the
// retail code, and the loyalty rules need it too.
'use strict';

const { tdb } = require('./tenant-db');

function cfgValue(key, fallback) {
  const row = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}

module.exports = { cfgValue };
