#!/usr/bin/env node
/**
 * diagnose_pita_choice.js — why does Whole-Wheat Pita (Frozen) keep meeting
 * "Please choose" at checkout, even after the customer removes it and adds it
 * again from the product page?
 *
 * Ash, 2026-10-05: customer Syd's order is refused with choice_required on the
 * pita (§433). Re-adding the line did not help, so it is not a stale cart line.
 * The lead: the product page pre-selects a choice (its default, or the only
 * choice of a required question) without checking sold_out, then drops sold-out
 * choices when it builds the cart line — so the line carries no answer. A
 * choice counts as sold out when it is linked to a product (stock_product_id)
 * that is unpublished, inactive or out of stock, and §431 (same day) made
 * linking a choice to a product the way to give it a picture.
 *
 * This prints the pita's questions, their choices, each choice's link, and the
 * linked product's published / active / stock state, plus when each was last
 * touched. It decides nothing and changes nothing: opened readonly, and a write
 * is attempted and REQUIRED to fail before any query runs.
 *
 * RUN: .github/workflows/ro-query.yml, script = scripts/diagnose_pita_choice.js
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');
const out = (s = '') => console.log(s);

let db;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch (e) { console.error(`[pita] cannot open ${DB_PATH}: ${e && e.message}`); process.exit(1); }
try {
  db.prepare('CREATE TABLE _pita_write_probe (x INTEGER)').run();
  console.error('[pita] ABORT: the connection accepted a write. Not read-only.');
  process.exit(1);
} catch (e) {
  if (!/readonly|read-only|attempt to write/i.test(String(e && e.message))) {
    console.error(`[pita] ABORT: write refused for an unexpected reason: ${e && e.message}`);
    process.exit(1);
  }
}
const cols = (t) => { try { return db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name); } catch { return []; } };
const sel = (t, c, alias = c) => cols(t).includes(c) ? `${c} AS ${alias}` : `NULL AS ${alias}`;

out('db: ' + DB_PATH + '   run at (UTC): ' + new Date().toISOString());

const prods = db.prepare(
  `SELECT id, sku, name_en, name_cn, is_published, is_active, stock_qty,
          ${sel('store_products', 'updated_at')}
     FROM store_products
    WHERE LOWER(COALESCE(name_en,'')) LIKE '%pita%' OR COALESCE(name_cn,'') LIKE '%皮塔%'
    ORDER BY id`).all();
out('\n== PRODUCTS MATCHING "pita" ==');
for (const p of prods) {
  out(`  #${p.id} ${p.sku || ''} ${p.name_en} / ${p.name_cn}  published=${p.is_published} active=${p.is_active} stock=${p.stock_qty} updated=${p.updated_at || '?'}`);
}

const linked = db.prepare(
  `SELECT id, name_en, name_cn, is_published, is_active, stock_qty, ship_from_supplier, supplier_paused
     FROM store_products WHERE id = ?`);
for (const p of prods) {
  const opts = db.prepare(
    `SELECT id, question_en, question_cn, type, is_required, min_choices, max_choices,
            ${sel('retail_product_options', 'created_at')}, ${sel('retail_product_options', 'updated_at')}
       FROM retail_product_options WHERE product_id = ? ORDER BY sort_order, id`).all(p.id);
  if (!opts.length) continue;
  out(`\n== QUESTIONS ON #${p.id} ${p.name_en} ==`);
  for (const o of opts) {
    out(`  option #${o.id} type=${o.type} REQUIRED=${o.is_required ? 'YES' : 'no'} min=${o.min_choices} max=${o.max_choices} created=${o.created_at || '?'} updated=${o.updated_at || '?'}`);
    out(`    Q: ${o.question_en || ''} / ${o.question_cn || ''}`);
    const ch = db.prepare(
      `SELECT id, label_en, label_cn, price_delta, is_default, stock_product_id,
              ${sel('retail_product_option_choices', 'updated_at')}
         FROM retail_product_option_choices WHERE option_id = ? ORDER BY sort_order, id`).all(o.id);
    if (!ch.length) out('    (no choices)');
    for (const c of ch) {
      let link = 'no link';
      if (c.stock_product_id) {
        const l = linked.get(c.stock_product_id);
        link = l
          ? `LINKED to #${l.id} ${l.name_en} published=${l.is_published} active=${l.is_active} stock=${l.stock_qty} supplier=${l.ship_from_supplier ? (l.supplier_paused ? 'paused' : 'yes') : 'no'}`
          : `LINKED to #${c.stock_product_id} (ROW MISSING)`;
      }
      out(`    choice #${c.id} "${c.label_en}" / "${c.label_cn}" delta=${Number(c.price_delta) || 0}${c.is_default ? ' [DEFAULT]' : ''} updated=${c.updated_at || '?'}`);
      out(`      ${link}`);
    }
  }
}

out('\n== LAST 5 REFUSED/ABANDONED QUOTES WITH A PITA (checkout opened, by time) ==');
try {
  const ids = prods.map(p => p.id);
  const rows = db.prepare(
    `SELECT customer_id, created_at, items_json FROM retail_checkout_quotes ORDER BY id DESC LIMIT 400`).all();
  let n = 0;
  for (const r of rows) {
    let items = []; try { items = JSON.parse(r.items_json || '[]'); } catch {}
    if (!items.some(i => ids.includes(Number(i.product_id)))) continue;
    out(`  customer=${r.customer_id} at=${r.created_at} items=${r.items_json}`);
    if (++n >= 5) break;
  }
} catch (e) { out('  (quotes table unreadable: ' + e.message + ')'); }

// Round 2: re-adding did not help, and Syd's 04:29 checkout carried #255 beside
// the pita. Several mini app paths add with NO answers (product page "Buy
// together", home bundle block, favourites "Add all"). Is the pita in a
// buy-together set, and what is #255?
out('\n== #255 AND BUY-TOGETHER SETS THAT CONTAIN A PITA ==');
try {
  const p255 = db.prepare('SELECT id, sku, name_en, name_cn, bundle FROM store_products WHERE id = 255').get();
  if (p255) out(`  #255 ${p255.sku || ''} ${p255.name_en} / ${p255.name_cn}  bundle=${p255.bundle || '-'}`);
  const pitaIds = prods.map(p => p.id);
  for (const r of db.prepare(`SELECT id, name_en, bundle FROM store_products WHERE bundle IS NOT NULL AND bundle <> ''`).all()) {
    let ids = [];
    try {
      const b = JSON.parse(r.bundle);
      const arr = Array.isArray(b) ? b : (b && (b.items || b.product_ids || b.ids)) || [];
      ids = arr.map(x => Number(x && typeof x === 'object' ? (x.id || x.product_id) : x));
    } catch { ids = (String(r.bundle).match(/\d+/g) || []).map(Number); }
    if (ids.some(i => pitaIds.includes(i)) || pitaIds.includes(r.id)) {
      out(`  product #${r.id} ${r.name_en}  bundle=${r.bundle}`);
    }
  }
} catch (e) { out('  (unreadable: ' + e.message + ')'); }
try {
  const fav = db.prepare(`SELECT COUNT(*) AS n FROM retail_favorites WHERE customer_id = 269 AND product_id = 256`).get();
  out(`  customer 269 has the pita in favourites: ${fav && fav.n ? 'YES' : 'no'}`);
} catch (e) { out('  (favourites unreadable: ' + e.message + ')'); }
