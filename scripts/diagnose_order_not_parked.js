#!/usr/bin/env node
/**
 * diagnose_order_not_parked.js — why is THIS paid order not 'awaiting_restock'?
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_order_not_parked.js
 *   Input the order number with ORDER_NO=TC000735 (default below).
 *
 * READ-ONLY, and it proves that on the connection before reading anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * An order parks in 'awaiting_restock' three ways (routes/retail.js §80/§128):
 *   1. the customer answered the shortage modal with 'wait_for_restock',
 *   2. a short line today's fresh batch covers (batch park), or
 *   3. a short line whose oos_policy is 'backorder_all' (pre-order park).
 * Paths 2 and 3 run inside ONE guard that also requires: not pickup, a
 * fulfilling store, no bundle in the cart, NO STOCK-BACKED ADD-ON, and every
 * short line carrying a pre-order policy. Any one of those falling over leaves
 * a genuinely short order sitting in 'paid' with nothing saying why.
 *
 * This prints, for one order, the value of every input that guard reads, so the
 * arm that refused is named rather than guessed at.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const APP      = process.env.ROOTS_APP || '/root/roots-v2';
const ORDER_NO = process.env.ORDER_NO || 'TC000735';

let Database;
try { Database = require(path.join(APP, 'node_modules', 'better-sqlite3')); }
catch (e) { console.error('cannot load better-sqlite3: ' + e.message); process.exit(2); }

function candidates() {
  const list = [process.env.ROOTS_DB || path.join(APP, 'data', 'roots.db')];
  try {
    const d = path.join(APP, 'data', 'tenants');
    for (const f of fs.readdirSync(d)) if (f.endsWith('.db')) list.push(path.join(d, f));
  } catch (_) { /* single tenant */ }
  return list.filter(f => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } });
}

// Same two helpers routes/retail.js uses, copied rather than required so this
// reads the live rows without pulling the route's whole dependency tree in.
const effectiveOosPolicy = (p) => {
  if (p && Number(p.ship_from_supplier)) return 'always';
  const pol = (p && p.oos_policy) || '';
  if (['always', 'backorder_gz', 'backorder_all', 'strict'].includes(pol)) return pol;
  return (p && Number(p.is_batch_made)) ? 'backorder_gz' : 'strict';
};
const isPreorderPolicy  = (pol) => pol === 'backorder_gz' || pol === 'backorder_all';
const isLocalRunPreorder = (pol) => pol === 'backorder_all';

const files = candidates();
console.log(`Databases to read (${files.length}): ${files.join(', ') || '(none found)'}`);
console.log(`Looking for order_no = ${ORDER_NO}\n`);

let found = 0;
for (const file of files) {
  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { console.log(`${file}: cannot open read-only — ${e.message}`); continue; }
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (_) { proven = true; }
  if (!proven) { console.error(`FATAL: ${file} accepted a write — reading nothing`); try { db.close(); } catch (_) {} continue; }

  const complained = new Set();
  const moan = (sql, e) => {
    const key = sql.replace(/\s+/g, ' ').trim().slice(0, 90);
    if (complained.has(key)) return;
    complained.add(key);
    console.error(`  ! query failed: ${e.message}\n    ${key}…`);
  };
  const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { moan(sql, e); return []; } };
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) || null; } catch (e) { moan(sql, e); return null; } };
  const has = (t) => { try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t); } catch (_) { return false; } };
  const cols = (t) => { try { return new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name)); } catch (_) { return new Set(); } };

  if (!has('retail_orders')) { try { db.close(); } catch (_) {} continue; }
  const o = one('SELECT * FROM retail_orders WHERE order_no = ?', ORDER_NO);
  if (!o) { try { db.close(); } catch (_) {} continue; }
  found++;

  console.log(`═══ ${file} ═══`);
  console.log(`order #${o.id}  ${o.order_no}`);
  for (const k of ['status', 'channel', 'payment_method', 'store_id', 'routing_reason',
                   'fulfillment_type', 'delivery_mode', 'delivery_slot_kind', 'delivery_slot_label',
                   'scheduled_for', 'fallback_choice', 'awaiting_restock_pids',
                   'fulfillment_short_pids', 'created_at', 'paid_at', 'updated_at']) {
    if (k in o) console.log(`  ${k.padEnd(24)} ${o[k] === null ? '(null)' : o[k]}`);
  }

  const store = has('retail_stores') ? one('SELECT * FROM retail_stores WHERE id = ?', o.store_id) : null;
  console.log(`  store                    ${store ? `${store.code} / ${store.name_en}` : '(none)'}`);

  // ── The product rows the guard reads ───────────────────────────────────
  const ptable = has('store_products') ? 'store_products' : 'products';
  const pcols  = cols(ptable);
  const pick   = ['id', 'name_en', 'name_cn', 'sku', 'oos_policy', 'is_batch_made',
                  'ship_from_supplier', 'bundle_items', 'bundle_mode', 'stock_qty', 'is_active']
                 .filter(c => pcols.has(c));
  console.log(`\n  product table: ${ptable}`);

  const items = all('SELECT * FROM retail_order_items WHERE order_id = ? ORDER BY id', o.id);
  let hasStockedAddon = false, cartHasBundle = false;
  const shortHere = [];

  for (const it of items) {
    console.log(`\n  ── line: ${it.name_en || '(no name)'}  ×${it.qty}  product_id=${it.product_id}`);
    const p = it.product_id ? one(`SELECT ${pick.join(', ')} FROM ${ptable} WHERE id = ?`, it.product_id) : null;
    if (!p) { console.log('     product row: NOT FOUND'); continue; }
    const pol = effectiveOosPolicy(p);
    console.log(`     oos_policy(raw)=${p.oos_policy === null || p.oos_policy === undefined ? '(null)' : p.oos_policy}`
      + `  is_batch_made=${p.is_batch_made}  ship_from_supplier=${p.ship_from_supplier}`);
    console.log(`     effective policy = ${pol}   preorderable=${isPreorderPolicy(pol)}  local-run=${isLocalRunPreorder(pol)}`);

    const bundle = (p.bundle_items || '').trim();
    if (bundle && bundle !== '[]' && bundle !== 'null') { cartHasBundle = true; console.log(`     BUNDLE: ${bundle.slice(0, 120)}`); }

    // Stock at the fulfilling store, now.
    if (has('retail_store_stock')) {
      const s = one('SELECT * FROM retail_store_stock WHERE store_id = ? AND product_id = ?', o.store_id, it.product_id);
      if (s) {
        console.log(`     stock now @store ${o.store_id}: physical=${s.physical_qty} buffer=${s.safety_buffer} wechat_quota=${s.wechat_quota === null ? '(null)' : s.wechat_quota}`);
        const avail = Math.max(0, Number(s.physical_qty) - Number(s.safety_buffer));
        if (avail < Number(it.qty)) shortHere.push({ pid: it.product_id, name: it.name_en, pol, avail });
      } else {
        console.log(`     stock now @store ${o.store_id}: NO ROW (treated as 0)`);
        shortHere.push({ pid: it.product_id, name: it.name_en, pol, avail: 0 });
      }
    }

    // Chosen add-on options — the `hasStockedAddon` arm of the guard.
    let opts = [];
    try { opts = JSON.parse(it.options_json || '[]') || []; } catch (_) { opts = []; }
    if (opts.length) console.log(`     options_json: ${JSON.stringify(opts).slice(0, 400)}`);
    if (has('retail_product_option_choices')) {
      for (const op of (Array.isArray(opts) ? opts : [])) {
        const label = op && (op.choice_label_en || op.choice || op.label || op.value || op.label_en);
        if (!label) continue;
        const ch = all(
          `SELECT id, label_en, label_cn, stock_product_id FROM retail_product_option_choices
            WHERE (label_en = ? OR label_cn = ?)`, String(label), String(label));
        for (const c of ch) {
          console.log(`       choice "${c.label_en || c.label_cn}" → stock_product_id=${c.stock_product_id === null ? '(null)' : c.stock_product_id}`);
          if (c.stock_product_id) hasStockedAddon = true;
        }
        if (!ch.length) console.log(`       choice "${label}" → no retail_product_option_choices row matched`);
      }
    }
  }

  // ── The verdict ────────────────────────────────────────────────────────
  console.log(`\n  ── guard inputs ──`);
  console.log(`  isPickup            = ${o.fulfillment_type === 'pickup'}`);
  console.log(`  isWaitFlow          = ${o.fallback_choice === 'wait_for_restock'}`);
  console.log(`  cartHasBundle       = ${cartHasBundle}`);
  console.log(`  hasStockedAddon     = ${hasStockedAddon}`);
  console.log(`  short lines now     = ${shortHere.length ? shortHere.map(s => `${s.name}(${s.pol}, avail ${s.avail})`).join(', ') : '(none)'}`);
  const allShortPreorderable = shortHere.length && shortHere.every(s => isPreorderPolicy(s.pol));
  console.log(`  every short line preorderable = ${shortHere.length ? allShortPreorderable : 'n/a (nothing short now)'}`);

  const reasons = [];
  if (o.fulfillment_type === 'pickup') reasons.push('pickup order — park block is skipped');
  if (cartHasBundle) reasons.push('cart holds a bundle — park block is skipped');
  if (hasStockedAddon) reasons.push('a chosen add-on is stock-backed (stock_product_id) — park block is skipped');
  if (!shortHere.length) reasons.push('nothing is short at the fulfilling store RIGHT NOW (stock may have gone out after the order)');
  else if (!allShortPreorderable) reasons.push('at least one short line is NOT pre-orderable: '
    + shortHere.filter(s => !isPreorderPolicy(s.pol)).map(s => `${s.name} (${s.pol})`).join(', '));
  console.log(`\n  LIKELY REASON: ${reasons.length ? reasons.join(' · ') : 'none of the guard arms explain it — stock was probably sufficient at checkout time'}`);

  // Stock history for the short products, so "was it short AT CHECKOUT" is answerable.
  if (has('retail_stock_ledger')) {
    const lcols = cols('retail_stock_ledger');
    const pidsToTrace = items.map(i => i.product_id).filter(Boolean);
    console.log(`\n  ── stock ledger around this order (store ${o.store_id}) ──`);
    for (const pid of pidsToTrace) {
      const rows = all(
        `SELECT * FROM retail_stock_ledger
          WHERE product_id = ? ${lcols.has('store_id') ? 'AND store_id = ?' : ''}
          ORDER BY id DESC LIMIT 8`,
        ...(lcols.has('store_id') ? [pid, o.store_id] : [pid]));
      console.log(`   product ${pid}:`);
      for (const r of rows) {
        console.log(`     ${r.created_at || r.at || ''}  delta=${r.delta ?? r.qty_delta ?? '?'}  reason=${r.reason}  note=${(r.note || '').slice(0, 60)}`);
      }
      if (!rows.length) console.log('     (no ledger rows)');
    }
  }

  try { db.close(); } catch (_) {}
}

if (!found) console.log(`No database on this box holds an order numbered ${ORDER_NO}.`);
