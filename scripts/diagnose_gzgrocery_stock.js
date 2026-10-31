#!/usr/bin/env node
// READ-ONLY. Why did gzgrocery sell a product we had none of?
//
// gzgrocery orders land in our system AFTER the fact (the OpenCart client in
// lib/gzgrocery-admin.js is read-only — we never write their storefront). The
// ONLY lever we have on what they can order is the Guanyi ERP on-hand number,
// pushed by this chain:
//
//   retail_store_stock.physical_qty (tianhe)
//     → inventory.adjustStock → enqueueChannelSync → guanyi-sync.enqueueProductStock
//     → guanyi_sync_queue (pending)
//     → scripts/guanyi-daemon.js processStockQueue → Guanyi 库存调整单
//     → gzgrocery reads Guanyi
//
// Every link in that chain can break SILENTLY — nothing alerts on any of them.
// This script walks the chain for one SKU and names the first broken link.
//
//   node scripts/diagnose_gzgrocery_stock.js            # defaults to 1-420
//   node scripts/diagnose_gzgrocery_stock.js 1-420 1-400
//
// Mutates nothing.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH, { readonly: true });

const STORE_CODE = process.env.GUANYI_STORE_CODE || 'tianhe';
const SKUS = process.argv.slice(2).filter(a => !a.startsWith('-'));
if (!SKUS.length) SKUS.push('1-420');

const has = (t) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const findings = [];
function flag(sku, severity, msg) { findings.push({ sku, severity, msg }); }

// ── Resolve the Tianhe store ────────────────────────────────────────────────
const store = db.prepare(
  `SELECT id, code, name_en FROM retail_stores WHERE code = ? LIMIT 1`
).get(STORE_CODE);
if (!store) { console.log(`!! no retail_stores row with code='${STORE_CODE}'. Aborting.`); process.exit(1); }
console.log(`DB     : ${DB_PATH}`);
console.log(`Store  : ${store.name_en || store.code} (#${store.id})\n`);

for (const skuArg of SKUS) {
  const key = skuArg.toUpperCase();
  console.log('='.repeat(78));
  console.log(`SKU ${key}`);
  console.log('='.repeat(78));

  // The daemon matches an order line to a product by the numeric code inside the
  // SKU, so match the same way here (a 'S(1-420)' sample twin shares the code).
  const products = db.prepare(
    `SELECT id, sku, name_en, name_cn FROM store_products
      WHERE sku IS NOT NULL AND sku <> '' AND UPPER(sku) LIKE ? ORDER BY (UPPER(sku) = ?) DESC, id`
  ).all(`%${key}%`, key);
  if (!products.length) { console.log(`  no store_products row matching ${key}\n`); continue; }

  for (const p of products) {
    const canonical = String(p.sku).toUpperCase() === key;
    console.log(`\n-- product #${p.id}  sku=${p.sku}${canonical ? ' (canonical)' : ' (variant/twin)'}`);
    console.log(`   ${p.name_en || ''}${p.name_cn ? ' / ' + p.name_cn : ''}`);

    // 1. What Tianhe actually holds, and what our own channels consider sellable.
    const st = db.prepare(
      `SELECT physical_qty, safety_buffer, updated_at FROM retail_store_stock
        WHERE store_id = ? AND product_id = ?`
    ).get(store.id, p.id);
    const reserved = db.prepare(
      `SELECT COALESCE(SUM(qty),0) AS n FROM retail_stock_reservations
        WHERE store_id = ? AND product_id = ? AND status = 'active' AND expires_at > CURRENT_TIMESTAMP`
    ).get(store.id, p.id).n;
    const phys = st ? st.physical_qty : 0;
    const buf  = st ? st.safety_buffer : 0;
    const avail = Math.max(0, phys - buf - reserved);
    console.log(`   stock  : physical=${phys}  safety_buffer=${buf}  active_reservations=${reserved}  -> sellable=${avail}`);
    if (!st) flag(p.sku, 'INFO', 'no retail_store_stock row at Tianhe (treated as 0)');
    if (phys > 0 && avail === 0) {
      flag(p.sku, 'HIGH',
        `Tianhe reads OUT to our own channels (sellable=0) but physical_qty=${phys}. ` +
        `Guanyi is pushed physical_qty, NOT sellable — so gzgrocery still sees ${phys}.`);
    }

    // 2. Is the product even subscribed to the Guanyi fan-out?
    const map = has('guanyi_product_map') ? db.prepare(
      `SELECT * FROM guanyi_product_map WHERE retail_store_id = ? AND product_id = ?`
    ).get(store.id, p.id) : null;
    if (!map) {
      console.log(`   guanyi : NO MAPPING`);
      flag(p.sku, 'HIGH', 'no guanyi_product_map row — stock changes are never enqueued for Guanyi at all.');
    } else {
      console.log(`   guanyi : sync_enabled=${map.sync_enabled}  sku_id=${map.guanyi_sku_id || '(none)'}  ` +
                  `last_pushed_qty=${map.last_pushed_qty}  last_delta=${map.last_delta}  last_pushed_at=${map.last_pushed_at || '(never)'}`);
      if (!map.sync_enabled) {
        flag(p.sku, 'HIGH',
          'sync_enabled=0 — this product is EXCLUDED from the Guanyi fan-out. ' +
          'guanyi-daemon.js:195 clears this automatically for any SKU Guanyi reports as 已停用, ' +
          'and nothing ever turns it back on. Re-enable it in the Guanyi admin tab.');
      }
      if (!map.guanyi_sku_id) {
        flag(p.sku, 'HIGH', 'mapping has no guanyi_sku_id — every queued push fails with "no guanyi mapping".');
      }
      if (map.last_pushed_at && st && st.updated_at && map.last_pushed_at < st.updated_at) {
        flag(p.sku, 'HIGH',
          `stock changed at ${st.updated_at} but the last Guanyi push was ${map.last_pushed_at} — the push never caught up.`);
      }
      if (map.last_pushed_qty != null && map.last_pushed_qty !== phys) {
        flag(p.sku, 'MED',
          `last_pushed_qty=${map.last_pushed_qty} != Tianhe physical_qty=${phys} — Guanyi is holding a stale number.`);
      }
    }

    // 3. Queue rows — the honest record of whether a push was attempted.
    if (has('guanyi_sync_queue')) {
      const q = db.prepare(
        `SELECT id, new_qty, status, attempts, last_error, created_at, processed_at
           FROM guanyi_sync_queue WHERE product_id = ? AND retail_store_id = ?
          ORDER BY id DESC LIMIT 12`
      ).all(p.id, store.id);
      console.log(`   queue  : ${q.length ? '' : '(no rows ever queued)'}`);
      for (const r of q) {
        console.log(`     #${pad(r.id, 7)} qty=${pad(r.new_qty, 5)} ${pad(r.status, 11)} att=${r.attempts}  ` +
                    `${pad(r.created_at, 20)} ${r.last_error || ''}`);
      }
      if (!q.length && map && map.sync_enabled) {
        flag(p.sku, 'HIGH', 'mapping is enabled but NO queue row was ever written — adjustStock never ran for this product at Tianhe.');
      }
      const stuck = q.filter(r => r.status === 'error');
      if (stuck.length) {
        flag(p.sku, 'HIGH',
          `${stuck.length} queue row(s) in status='error' (e.g. "${stuck[0].last_error}"). ` +
          `The daemon only picks up status='pending' AND attempts<3 — these are dead and will NEVER retry. ` +
          `Guanyi is stuck at whatever it last held.`);
      }
      const pending = q.filter(r => r.status === 'pending' || r.status === 'processing');
      if (pending.length) {
        flag(p.sku, 'MED', `${pending.length} row(s) still pending/processing — is the guanyi-sync daemon running?`);
      }
      // A row retired as delta==0 marks itself done + rewrites last_pushed_qty
      // WITHOUT creating a Guanyi document (guanyi-daemon.js:207, guanyi-browser.js:260).
      // If the listing read it compared against was stale, the correction is lost.
      const laundered = q.filter(r => r.status === 'done' && r.last_error === null && r.new_qty !== phys);
      if (laundered.length) {
        flag(p.sku, 'MED',
          `${laundered.length} row(s) marked done at a qty that no longer matches Tianhe — ` +
          `if these were "delta==0" skips against a stale listing read, no document was ever written.`);
      }
    }

    // 4. What Guanyi last told us it holds.
    if (has('guanyi_listings') && map && map.guanyi_sku_id) {
      const l = db.prepare(
        `SELECT guanyi_name, current_qty, scraped_at FROM guanyi_listings WHERE store_code = ? AND sku_id = ?`
      ).get(STORE_CODE, String(map.guanyi_sku_id));
      if (l) {
        console.log(`   listing: guanyi_qty=${l.current_qty}  scraped_at=${l.scraped_at}  (${l.guanyi_name})`);
        if (l.current_qty > 0 && phys <= 0) {
          flag(p.sku, 'HIGH',
            `Guanyi still shows ${l.current_qty} on hand while Tianhe is ${phys} — this is exactly the number gzgrocery can order against.`);
        }
      } else {
        console.log(`   listing: (sku_id ${map.guanyi_sku_id} not in the cached Guanyi listing)`);
        flag(p.sku, 'MED', 'sku_id absent from guanyi_listings — pushes fail with "sku not found in Guanyi list".');
      }
    }

    // 5. Did gzgrocery order it into the negative?
    if (has('gzgrocery_orders')) {
      const orders = db.prepare(
        `SELECT order_id, order_no, status, date_added, items_json, decremented, reversed
           FROM gzgrocery_orders WHERE items_json LIKE ? ORDER BY order_id DESC LIMIT 8`
      ).all(`%"${p.sku}"%`);
      if (orders.length) {
        console.log(`   gz ord : ${orders.length} recent order(s) containing this SKU`);
        for (const o of orders) {
          let qty = 0;
          try { for (const it of JSON.parse(o.items_json || '[]')) if (it.product_id === p.id) qty += it.qty; } catch {}
          console.log(`     GZ-${pad(o.order_id, 9)} ${pad(o.status, 12)} x${pad(qty, 4)} ${pad(o.date_added, 20)} ` +
                      `dec=${o.decremented} rev=${o.reversed}`);
        }
      }
    }

    // 6. The ledger tells us whether the decrement clamped at zero (= oversell).
    if (has('retail_stock_ledger')) {
      const led = db.prepare(
        `SELECT delta, reason, balance_after, actor_label, note, created_at
           FROM retail_stock_ledger WHERE store_id = ? AND product_id = ?
          ORDER BY id DESC LIMIT 8`
      ).all(store.id, p.id);
      if (led.length) {
        console.log(`   ledger :`);
        for (const r of led) {
          console.log(`     ${pad(r.created_at, 20)} ${pad(r.delta >= 0 ? '+' + r.delta : r.delta, 6)} ` +
                      `-> ${pad(r.balance_after, 5)} ${pad(r.reason, 22)} ${r.note || ''}`);
        }
        // gzgrocery-order-daemon.js:340 clamps with Math.max(0, cur - qty): a sale
        // against zero stock writes a delta of 0 and the shortfall vanishes.
        const swallowed = led.filter(r => r.reason === 'gzgrocery_order' && r.delta === 0);
        if (swallowed.length) {
          flag(p.sku, 'HIGH',
            `${swallowed.length} gzgrocery_order ledger row(s) with delta=0 — gzgrocery sold units we did not have. ` +
            `The daemon clamps at zero (Math.max(0, cur - qty)), so the shortfall was silently absorbed and never alerted.`);
        }
      }
    }
  }
  console.log('');
}

// ── Chain-wide health ────────────────────────────────────────────────────────
console.log('='.repeat(78));
console.log('GUANYI SYNC — OVERALL');
console.log('='.repeat(78));
if (has('guanyi_sync_queue')) {
  for (const r of db.prepare(
    `SELECT status, COUNT(*) AS n, MAX(created_at) AS newest FROM guanyi_sync_queue GROUP BY status ORDER BY n DESC`
  ).all()) console.log(`  ${pad(r.status, 12)} ${pad(r.n, 6)} newest=${r.newest}`);

  const dead = db.prepare(
    `SELECT last_error, COUNT(*) AS n FROM guanyi_sync_queue WHERE status='error'
      GROUP BY last_error ORDER BY n DESC LIMIT 10`
  ).all();
  if (dead.length) {
    console.log(`\n  dead rows by reason (never retried — the daemon only reads pending & attempts<3):`);
    for (const r of dead) console.log(`    ${pad(r.n, 6)} ${r.last_error}`);
  }
}
if (has('guanyi_product_map')) {
  const off = db.prepare(
    `SELECT COUNT(*) AS n FROM guanyi_product_map WHERE sync_enabled = 0`
  ).get().n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM guanyi_product_map`).get().n;
  console.log(`\n  mappings: ${total} total, ${off} with sync_enabled=0 (silently excluded from every push)`);
  if (off) {
    for (const r of db.prepare(
      `SELECT p.sku, p.name_en, m.last_pushed_qty, m.last_pushed_at
         FROM guanyi_product_map m JOIN store_products p ON p.id = m.product_id
        WHERE m.sync_enabled = 0 ORDER BY m.updated_at DESC LIMIT 20`
    ).all()) console.log(`    ${pad(r.sku, 10)} ${pad(r.name_en, 44)} last_pushed=${r.last_pushed_qty} @ ${r.last_pushed_at || 'never'}`);
  }
}
if (has('guanyi_sync_log')) {
  console.log(`\n  last 10 sync-log events:`);
  for (const r of db.prepare(
    `SELECT event_type, status, error_msg, created_at FROM guanyi_sync_log ORDER BY id DESC LIMIT 10`
  ).all()) console.log(`    ${pad(r.created_at, 20)} ${pad(r.event_type, 14)} ${pad(r.status, 9)} ${r.error_msg || ''}`);
}

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(78));
console.log('FINDINGS');
console.log('='.repeat(78));
if (!findings.length) {
  console.log('  No broken link found in the push chain for these SKUs.');
  console.log('  If Guanyi holds the right number, the gap is downstream of us: we have NO');
  console.log('  write path into gzgrocery\'s OpenCart (lib/gzgrocery-admin.js is read-only),');
  console.log('  so their storefront only stops selling when THEIR Guanyi sync runs.');
} else {
  for (const sev of ['HIGH', 'MED', 'INFO']) {
    for (const f of findings.filter(x => x.severity === sev)) {
      console.log(`  [${sev}] ${f.sku}: ${f.msg}`);
    }
  }
}
console.log('');
