#!/usr/bin/env node
/**
 * READ-ONLY. Which products carry a 'text' option — and which are unbuyable?
 *
 * Context. retail_product_options.type allows 'single' | 'multi' | 'text', but
 * 'text' is half-built: it stores no rows in retail_product_option_choices, and
 * NEITHER storefront renders an input for one. The mini-app option sheet loops
 * over opt.choices (miniapp/pages/product/product.wxml:332-345) and the web
 * sheet does the same (public/shop.html buildSheet). Selection state is keyed by
 * choice id, so _selIds (miniapp/pages/product/product.js:844-847) can only ever
 * return [] for a text option.
 *
 * Two outcomes, one of them severe:
 *
 *   is_required = 0 → the question is never asked and the answer is never
 *     collected. Silent, cosmetic-ish, no lost sale.
 *
 *   is_required = 1 → the add-to-cart guard (product.js:856, and :908 in the
 *     sheet; shop.html:5371 on the web) tests `is_required && !_selIds(o).length`
 *     and can never pass. Add-to-cart toasts forever. If the product is
 *     PUBLISHED and ACTIVE, nobody can buy it, on either storefront, and the
 *     customer has no way through.
 *
 * This script answers "does that state exist in production, and on what?".
 * It reads two tables and prints a verdict. It writes nothing — the repair
 * (retype the option, drop it, or build the input on both clients) is a
 * decision, not something a diagnostic should take.
 *
 *   node scripts/diagnose_text_options.js
 *
 * Mutates nothing.
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Prove read-only, do not assume it ───────────────────────────────────────
let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH + '\n');

const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const lpad = (s, n) => String(s == null ? '' : s).padStart(n);

// Baseline, so a zero result reads as "checked and clean" rather than
// "query returned nothing, possibly wrong table".
const totals = db.prepare(
  `SELECT type, COUNT(*) AS n FROM retail_product_options GROUP BY type ORDER BY type`
).all();
console.log('All product options by type:');
for (const t of totals) console.log('  ' + pad(t.type, 8) + lpad(t.n, 6));
console.log('  ' + pad('TOTAL', 8) + lpad(totals.reduce((s, t) => s + t.n, 0), 6) + '\n');

// The question itself. LEFT JOIN so an option orphaned from its product (or
// pointing at a row that no longer exists) still surfaces rather than vanishing.
const rows = db.prepare(
  `SELECT o.id, o.product_id, o.question_en, o.question_cn, o.is_required,
          p.sku, p.name_en, p.name_cn,
          p.is_published, COALESCE(p.is_active, 1) AS is_active,
          (SELECT COUNT(*) FROM retail_product_option_choices c
            WHERE c.option_id = o.id) AS n_choices
     FROM retail_product_options o
LEFT JOIN store_products p ON p.id = o.product_id
    WHERE o.type = 'text'
 ORDER BY o.is_required DESC, p.is_published DESC, o.product_id, o.id`
).all();

if (!rows.length) {
  console.log('No text options exist. Nothing is broken by this; nothing to repair.');
  process.exit(0);
}

console.log(`${rows.length} text option(s) found:\n`);
console.log('  ' + pad('opt', 5) + pad('prod', 6) + pad('sku', 14) + pad('req', 5) +
            pad('live', 6) + pad('chx', 5) + 'question');
console.log('  ' + '-'.repeat(88));

let unbuyable = 0, silent = 0;
for (const r of rows) {
  // "live" = a customer can actually reach this product on a storefront.
  const live = r.is_published === 1 && r.is_active === 1;
  const req = r.is_required === 1;
  if (req && live) unbuyable++; else silent++;
  console.log('  ' + pad(r.id, 5) + pad(r.product_id, 6) + pad(r.sku || '—', 14) +
              pad(req ? 'YES' : 'no', 5) + pad(live ? 'yes' : 'no', 6) +
              pad(r.n_choices, 5) +
              String(r.question_en || r.question_cn || '(untitled)').slice(0, 40));
}

console.log('\n' + '='.repeat(90));
if (unbuyable) {
  console.log(`VERDICT: ${unbuyable} PUBLISHED product(s) cannot be bought on either storefront.`);
  console.log('Each row above with req=YES and live=yes is a live lost sale.');
} else {
  console.log('VERDICT: no published product is blocked — every text option is optional');
  console.log('or sits on an unpublished/inactive product.');
}
if (silent) {
  console.log(`${silent} further text option(s) collect nothing but block no sale.`);
}
console.log('Nothing was modified.');
