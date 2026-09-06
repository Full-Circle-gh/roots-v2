#!/usr/bin/env node
/**
 * PRE-LAUNCH GATE — every product on a shop menu has BOTH names.
 *
 *   node scripts/check_shop_listing_names.js
 *
 * §44 makes it a launch prerequisite, not a later enhancement: "every product
 * listed at a shop requires both a Chinese and an English name." Nothing
 * enforced it. The public menu at /s/:shopCode falls back to whichever name it
 * has so a half-filled product never renders a blank line — which is the right
 * behaviour for a page already live and the WRONG thing to launch on, because
 * a customer reading Chinese would silently get an English name and nobody
 * would hear about it. This is the check that stops that being the launch
 * state.
 *
 * WHY A SCRIPT AND NOT A GATE ON SHOP ACTIVATION. What "goes live" in this
 * system is shops.is_active, and its only writer is PATCH
 * /api/retail-admin/shops/:id — an existing route this build does not touch.
 * A script is therefore the only additive way to gate, and it is how this repo
 * already gates: check_ledger_invariants.js, check_money_invariants.js.
 *
 * IT PASSES ON AN EMPTY DATABASE, and that is a real answer rather than a
 * dodge — no shop has any listing yet, so nothing is blocked. scripts/
 * run-suites.js discovers check_* files and runs them bare in CI, so a check
 * that threw or refused on an empty checkout would be a permanent red for no
 * finding. The red-proof — that it DOES go red, and names the product and the
 * language — is in scripts/test_shop_menu.js, the pairing run-suites.js
 * describes for check_money_invariants.js and its own test twin.
 *
 * Exit 0 = nothing blocked. Exit 1 = at least one listing is missing a name.
 */
'use strict';

const path = require('path');

function main() {
  let db;
  try {
    db = require(path.join('..', 'database'));
  } catch (e) {
    console.error('check_shop_listing_names: could not open the database —', e.message);
    return 1;
  }

  // A tenant DB that predates the shops migration simply has nothing to check.
  const have = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!have('shops') || !have('shop_listings') || !have('store_products')) {
    console.log('check_shop_listing_names: shops tables not present — nothing to check.');
    return 0;
  }

  // Active shops only. A shop switched off is not live, so its menu is not yet
  // a promise to anybody, and blocking on it would stop an operator building a
  // menu before opening — which is the normal way to open one.
  const rows = db.prepare(`
    SELECT s.public_code, s.id AS shop_id,
           COALESCE(NULLIF(TRIM(s.display_name_en), ''), l.name_en, l.code) AS shop_name,
           p.id AS product_id, p.sku, p.name_en, p.name_cn
      FROM shop_listings sl
      JOIN shops s         ON s.id = sl.shop_id
      JOIN retail_stores l ON l.id = s.location_id
      JOIN store_products p ON p.id = sl.store_product_id
     WHERE s.is_active = 1 AND COALESCE(l.is_active, 1) = 1
       AND COALESCE(p.is_active, 1) = 1
       AND (TRIM(COALESCE(p.name_en, '')) = '' OR TRIM(COALESCE(p.name_cn, '')) = '')
     ORDER BY s.id, sl.sort_position, sl.id
  `).all();

  const listed = db.prepare(`
    SELECT COUNT(*) AS n FROM shop_listings sl
      JOIN shops s ON s.id = sl.shop_id WHERE s.is_active = 1
  `).get().n;

  if (!rows.length) {
    console.log(`check_shop_listing_names: OK — ${listed} listing(s) at active shops, all with both names.`);
    return 0;
  }

  console.error(`check_shop_listing_names: BLOCKED — ${rows.length} of ${listed} listing(s) are missing a name.\n`);
  console.error('§44: every product listed at a shop needs an English AND a Chinese name before launch.');
  console.error('Per §30 the Chinese name is copied from a live or locked source, or supplied by Ash — never composed.\n');
  for (const r of rows) {
    const missing = [];
    if (!String(r.name_en || '').trim()) missing.push('English (name_en)');
    if (!String(r.name_cn || '').trim()) missing.push('Chinese (name_cn)');
    const known = String(r.name_en || '').trim() || String(r.name_cn || '').trim() || '(no name at all)';
    console.error(`  shop ${r.shop_name || r.shop_id} · product #${r.product_id}` +
      `${r.sku ? ' [' + r.sku + ']' : ''} "${known}" — missing ${missing.join(' and ')}`);
  }
  console.error('');
  return 1;
}

process.exit(main());
