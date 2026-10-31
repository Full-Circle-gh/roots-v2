#!/usr/bin/env node
/**
 * Diagnose a FALSE "out of stock" at checkout.
 *
 * Context: a customer (Haizhu address, 工业大道中333号 / 燕岗) hit the
 * "Yuexiu is short of stock" fallback at checkout even though the operator
 * says every item is physically in stock at BOTH stores. This prints, for
 * each active store and each named product, the exact numbers the checkout
 * uses so we can see WHY a store reads short:
 *
 *   available = max(0, min(
 *                 physical_qty - safety_buffer - SUM(active reservations, all channels),
 *                 wechat_quota == NULL ? +inf : wechat_quota - SUM(active reservations, wechat)
 *               ))
 *   ok        = a retail_store_stock ROW EXISTS  AND  available >= qty
 *
 * The four ways a store can falsely read "short" even with product on the shelf:
 *   1. NO retail_store_stock row for that (store, product)  → exists:false → short
 *   2. wechat_quota set low / 0                              → channel cap bites
 *   3. safety_buffer eats the physical_qty
 *   4. stale 'active' reservations (abandoned pending orders) hold the stock
 *
 * Read-only. Changes nothing. Run ON THE SERVER, against data/roots.db:
 *   node scripts/diagnose_stock_shortage.js
 *   node scripts/diagnose_stock_shortage.js --items "Seitan,Falafel"
 *   node scripts/diagnose_stock_shortage.js --channel wechat
 */
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const CHANNEL = flag('--channel', 'wechat');
// Default to the seven items from the reported cart.
const DEFAULT_ITEMS = [
  'Probiotic Coconut Yogurt',
  'Arugula Basil Pesto',
  'Kara Coconut Cream',
  'Baked Falafel',
  'Seitan',
  'Chick EN Strips',
  'Mushroom Burger Pattie',
];
const ITEMS = flag('--items', '')
  ? flag('--items', '').split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_ITEMS;

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'), { readonly: true });

const stores = db.prepare(
  `SELECT id, code, name_en, name_cn, city, district, lat, lng, is_active
     FROM retail_stores WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`
).all();

console.log(`\nActive stores (${stores.length}):`);
for (const s of stores) {
  console.log(`  #${s.id} ${s.code || ''} ${s.name_en || ''} / ${s.name_cn || ''}  [${s.city || '?'} ${s.district || '?'}]  gps=${s.lat ?? 'NULL'},${s.lng ?? 'NULL'}`);
}

function parseBundle(json) {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.filter(x => x && x.id) : []; }
  catch { return []; }
}

// Resolve each requested name to its store_products row(s).
function findProducts(name) {
  return db.prepare(
    `SELECT id, name_en, name_cn, sku, bundle_items, is_active, is_published
       FROM store_products
      WHERE name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?
      ORDER BY is_published DESC, is_active DESC, id ASC`
  ).all(`%${name}%`, `%${name}%`, `%${name}%`);
}

function reservations(storeId, productId, channel) {
  const all = db.prepare(
    `SELECT COALESCE(SUM(qty),0) n FROM retail_stock_reservations
      WHERE store_id = ? AND product_id = ? AND status = 'active'`
  ).get(storeId, productId).n;
  const chan = db.prepare(
    `SELECT COALESCE(SUM(qty),0) n FROM retail_stock_reservations
      WHERE store_id = ? AND product_id = ? AND status = 'active' AND channel = ?`
  ).get(storeId, productId, channel).n;
  return { all, chan };
}

function availability(storeId, productId, channel) {
  const row = db.prepare(
    `SELECT physical_qty, safety_buffer, wechat_quota, meituan_quota
       FROM retail_store_stock WHERE store_id = ? AND product_id = ?`
  ).get(storeId, productId);
  if (!row) return { exists: false, available: 0, reason: 'NO STOCK ROW' };
  const r = reservations(storeId, productId, channel);
  const globalRemaining = Math.max(0, row.physical_qty - row.safety_buffer - r.all);
  const quota = channel === 'meituan' ? row.meituan_quota : channel === 'wechat' ? row.wechat_quota : null;
  const chanRemaining = quota == null ? Infinity : Math.max(0, quota - r.chan);
  const available = Math.max(0, Math.min(globalRemaining, chanRemaining));
  let reason = 'ok';
  if (available < 1) {
    if (quota != null && chanRemaining < globalRemaining) reason = `channel quota (${CHANNEL}_quota=${quota}, reserved ${r.chan})`;
    else if (row.physical_qty - row.safety_buffer <= 0) reason = `safety buffer (phys ${row.physical_qty} - safety ${row.safety_buffer})`;
    else if (r.all > 0) reason = `reservations hold ${r.all}`;
    else reason = 'zero physical';
  }
  return { exists: true, available, physical: row.physical_qty, safety: row.safety_buffer, quota, resAll: r.all, resChan: r.chan, reason };
}

const shorts = [];
for (const name of ITEMS) {
  const matches = findProducts(name);
  console.log(`\n────────────────────────────────────────────────────────`);
  if (!matches.length) { console.log(`"${name}"  → NO PRODUCT MATCHED`); continue; }
  // Prefer the published+active match; warn if ambiguous.
  const p = matches[0];
  if (matches.length > 1) {
    console.log(`"${name}"  → ${matches.length} matches, using #${p.id}. Others: ${matches.slice(1).map(m => '#'+m.id).join(', ')}`);
  }
  const bundle = parseBundle(p.bundle_items);
  console.log(`"${name}"  → #${p.id} ${p.name_en} / ${p.name_cn}  sku=${p.sku || '-'}  ${p.is_published ? 'published' : 'DRAFT'}${p.is_active ? '' : ' INACTIVE'}${bundle.length ? `  BUNDLE of ${bundle.length}` : ''}`);

  // What products' stock actually gates this line: the bundle components, or the product itself.
  const gating = bundle.length ? bundle.map(b => ({ id: b.id, qty: b.qty })) : [{ id: p.id, qty: 1 }];
  for (const g of gating) {
    const gp = db.prepare('SELECT name_en FROM store_products WHERE id = ?').get(g.id);
    const label = bundle.length ? `   component #${g.id} ${gp ? gp.name_en : '?'} ×${g.qty}` : '   ';
    if (bundle.length) console.log(label);
    for (const s of stores) {
      const a = availability(s.id, g.id, CHANNEL);
      const tag = (!a.exists || a.available < g.qty) ? '  ◄── SHORT' : '';
      if (tag) shorts.push({ name, store: s.name_en, product: g.id, reason: a.reason });
      console.log(
        `      ${(s.name_en || s.code || ('#'+s.id)).padEnd(12)}  ` +
        (a.exists
          ? `avail=${String(a.available).padStart(3)}  phys=${a.physical} safety=${a.safety} quota=${a.quota ?? '∞'} resAll=${a.resAll} res${CHANNEL}=${a.resChan}  ${a.reason}`
          : `${a.reason}`) + tag
      );
    }
  }
}

console.log(`\n════════════════════════════════════════════════════════`);
if (!shorts.length) {
  console.log('No store reads short for any item — the false-shortage is NOT in current stock data (stock may have recovered, or the shortage was a transient reservation during testing).');
} else {
  console.log(`Stores reading SHORT (${shorts.length}):`);
  for (const x of shorts) console.log(`  ${x.store.padEnd(12)} ${x.name}  →  ${x.reason}`);
  console.log('\nIf the reason is "NO STOCK ROW", that store was never seeded for that product → checkout treats it as out-of-stock even though it is on the shelf. Fix = seed a retail_store_stock row (or auto-create one) for that (store, product).');
}
console.log('');
db.close();
