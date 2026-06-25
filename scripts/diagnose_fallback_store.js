#!/usr/bin/env node
/*
 * diagnose_fallback_store.js  —  READ-ONLY diagnostic.
 *
 * Explains why the checkout "Some items out of stock" modal does (or does not)
 * offer option ③ "Ship from <other store>". That option only appears when the
 * server finds an ACTIVE store — other than the nearest one — whose *available*
 * stock covers the WHOLE order (the cart product AND every paid extra linked to
 * a stock product). This script prints the per-store availability breakdown so
 * you can see exactly which store fails that test and why.
 *
 * It writes NOTHING. Pure SELECTs via the same lib/inventory code the real
 * checkout uses, so the numbers match production behaviour 1:1.
 *
 * Usage (run on the server, where the prod DB lives):
 *   node scripts/diagnose_fallback_store.js --name "Quinoa Salad"
 *   node scripts/diagnose_fallback_store.js --product 300
 *   node scripts/diagnose_fallback_store.js --product 300 --district 越秀区 --city 广州市 --qty 1
 *   node scripts/diagnose_fallback_store.js --product 300 --tenant 1
 *
 * Flags:
 *   --product <id>     Product id (store_products.id). Either this or --name.
 *   --name "<text>"    Find the product by name (EN or CN, LIKE match).
 *   --district <cn>    Customer district (default 越秀区 — the Yuexiu case).
 *   --city <cn>        Customer city (default 广州市).
 *   --lat --lng        Optional GPS for true distance ranking (else district match).
 *   --qty <n>          Units of the main product (default 1).
 *   --channel <c>      Sales channel: wechat (default) | meituan.
 *   --tenant <id>      Tenant id (default 1 = Roots / global db).
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

require('./../database'); // ensure the global db is initialised
const inventory = require('./../lib/inventory');
const { tenantAls, getTenantDb, tdb } = require('./../lib/tenant-db');

// ── arg parsing ────────────────────────────────────────────────────────────
function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const TENANT   = parseInt(arg('tenant', '1'), 10) || 1;
const QTY      = Math.max(1, parseInt(arg('qty', '1'), 10) || 1);
const CHANNEL  = String(arg('channel', 'wechat'));
const DISTRICT = String(arg('district', '越秀区'));
const CITY     = String(arg('city', '广州市'));
const LAT      = arg('lat', null) != null ? Number(arg('lat')) : null;
const LNG      = arg('lng', null) != null ? Number(arg('lng')) : null;

function bar() { console.log('─'.repeat(74)); }
function fmt(n) { return n === Infinity ? '∞' : String(n); }

tenantAls.run(getTenantDb(TENANT), () => {
  const db = tdb();

  // ── resolve the product ──────────────────────────────────────────────────
  let productId = arg('product', null);
  const name = arg('name', null);
  if (productId) productId = parseInt(productId, 10);
  if (!productId && name && name !== true) {
    const like = '%' + String(name).trim() + '%';
    const rows = db.prepare(
      `SELECT id, name_en, name_cn FROM store_products
        WHERE (name_en LIKE ? OR name_cn LIKE ?) ORDER BY id LIMIT 10`
    ).all(like, like);
    if (!rows.length) { console.error('No product matched name:', name); process.exit(1); }
    if (rows.length > 1) {
      console.log('Multiple products matched — re-run with --product <id>:');
      rows.forEach(r => console.log(`   ${r.id}  ${r.name_en} · ${r.name_cn}`));
      process.exit(0);
    }
    productId = rows[0].id;
  }
  if (!productId) { console.error('Pass --product <id> or --name "<text>".'); process.exit(1); }

  const p = db.prepare(
    `SELECT id, name_en, name_cn, sku, oos_policy, is_batch_made, is_active, is_published
       FROM store_products WHERE id = ?`
  ).get(productId);
  if (!p) { console.error('No product with id', productId); process.exit(1); }

  console.log('');
  bar();
  console.log(`PRODUCT  #${p.id}  ${p.name_en} · ${p.name_cn}`);
  console.log(`  sku=${p.sku || '—'}  oos_policy=${p.oos_policy || '(blank→legacy)'}  ` +
              `is_batch_made=${p.is_batch_made}  active=${p.is_active}  published=${p.is_published}`);
  console.log(`  cart qty=${QTY}  channel=${CHANNEL}`);
  bar();

  // ── build the order line-set: main product + any linked paid extras ──────
  // A paid extra linked via retail_product_option_choices.stock_product_id
  // draws its OWN stock, so a fallback store must also have it. We list every
  // such linked product and treat 1 unit per main unit as a worst-case demand
  // (the real cart only includes the extras the customer actually picked —
  // re-run with those if you want an exact match).
  const linked = db.prepare(
    `SELECT DISTINCT c.stock_product_id AS pid, c.label_en, c.label_cn
       FROM retail_product_option_choices c
       JOIN retail_product_options o ON o.id = c.option_id
      WHERE o.product_id = ? AND c.stock_product_id IS NOT NULL`
  ).all(productId);

  const lines = [{ product_id: productId, qty: QTY, label: `${p.name_en} (main)` }];
  if (linked.length) {
    console.log('\nLinked paid extras (each draws its own stock — a fallback store needs these too):');
    for (const l of linked) {
      const lp = db.prepare('SELECT name_en, name_cn FROM store_products WHERE id = ?').get(l.pid);
      console.log(`   choice "${l.label_en}" → stock product #${l.pid} ${lp ? lp.name_en : '(missing!)'}`);
    }
    console.log('   NOTE: only the extras the customer actually selected count. ' +
                'This script does NOT add them as demand by default — pass --also below if needed.');
  } else {
    console.log('\nNo paid extras link to a stock product. Only the main product gates stock.');
  }
  // Optional explicit extra demand: --also 456,789
  const also = arg('also', null);
  if (also && also !== true) {
    for (const idStr of String(also).split(',')) {
      const id = parseInt(idStr.trim(), 10);
      if (id) lines.push({ product_id: id, qty: QTY, label: `extra #${id}` });
    }
  }

  // ── per-store availability for every line ────────────────────────────────
  const stores = inventory.listStores({ activeOnly: false });
  console.log(`\nStores in this tenant: ${stores.length} ` +
              `(${stores.filter(s => s.is_active).length} active)`);

  const addr = { city: CITY, district: DISTRICT, lat: LAT, lng: LNG };

  // Compute each store's verdict: can it ship EVERY line?
  const verdicts = stores.map(s => {
    const dist = inventory.storeDistanceKm(s, addr);
    const perLine = lines.map(ln => {
      const av = inventory.getAvailable(s.id, ln.product_id, CHANNEL);
      return { ln, av, ok: av.exists && av.available >= ln.qty };
    });
    return { store: s, dist, perLine, ok: perLine.every(x => x.ok) };
  });

  for (const v of verdicts) {
    const s = v.store;
    bar();
    const tag = s.is_active ? 'ACTIVE' : 'INACTIVE (excluded from routing!)';
    console.log(`STORE #${s.id} ${s.name_en} · ${s.name_cn}  [${tag}]  ` +
                `district=${s.district || '—'}  dist=${v.dist == null ? '—' : v.dist.toFixed(1) + 'km'}`);
    for (const x of v.perLine) {
      const a = x.av;
      console.log(`   ${x.ok ? '✓' : '✗'} ${x.ln.label} (need ${x.ln.qty})`);
      if (!a.exists) {
        console.log(`       no stock row at this store → available 0`);
      } else {
        console.log(`       physical=${a.physical}  safety_buffer=${a.safety}  ` +
                    `${CHANNEL}_quota=${a.channelQuota == null ? 'none(∞)' : a.channelQuota}`);
        console.log(`       active reservations: all-channels=${a.activeAllChannels}  ` +
                    `${CHANNEL}=${a.activeThisChannel}`);
        console.log(`       → AVAILABLE = ${a.available}` +
                    (a.available < x.ln.qty ? `  (short by ${x.ln.qty - a.available})` : ''));
      }
    }
    console.log(`   STORE CAN SHIP WHOLE ORDER: ${v.ok ? 'YES' : 'NO'}` +
                (s.is_active ? '' : '  (but INACTIVE, so it never counts)'));
  }

  // ── the actual server verdict via analyzeShortage (forces stock gate) ────
  bar();
  console.log('SERVER VERDICT  (analyzeShortage, same-day GZ → stock gate ON)');
  const analysis = inventory.analyzeShortage({
    address: { ...addr, address: CITY + DISTRICT },
    items: lines.map(l => ({ product_id: l.product_id, qty: l.qty })),
    deliverySlotId: 'right_away',
    channel: CHANNEL,
  });
  console.log(`   gate            = ${analysis.gate}` +
              (analysis.gate === 'options_5' ? '  → out-of-stock modal shown' : ''));
  console.log(`   nearest store   = ${analysis.nearest ? `#${analysis.nearest.store.id} ${analysis.nearest.store.name_en} (ok=${analysis.nearest.ok})` : 'none'}`);
  if (analysis.fallback) {
    console.log(`   FALLBACK store  = #${analysis.fallback.store.id} ${analysis.fallback.store.name_en}` +
                `  → option ③ "Ship from ${analysis.fallback.store.name_en}" WILL show`);
  } else {
    console.log(`   FALLBACK store  = none  → option ③ HIDDEN (only Cancel / Replace / Wait shown)`);
  }
  if (analysis.missing_items && analysis.missing_items.length) {
    console.log(`   short at nearest: ` +
      analysis.missing_items.map(m => `${m.name_en || m.product_id} (have ${m.available}, need ${m.qty})`).join('; '));
  }

  // ── plain-English conclusion ─────────────────────────────────────────────
  bar();
  const otherActiveCanShip = verdicts.filter(v =>
    v.store.is_active && analysis.nearest && v.store.id !== analysis.nearest.store.id && v.ok);
  console.log('CONCLUSION');
  if (analysis.fallback) {
    console.log('   A fallback store exists and option ③ should appear. If the customer');
    console.log('   did NOT see it, they are likely on an older mini-app build — publish it.');
  } else if (!analysis.nearest) {
    console.log('   No active store / no routing — check that any store is marked Active.');
  } else if (otherActiveCanShip.length === 0) {
    const inactiveButStocked = verdicts.filter(v => !v.store.is_active && v.ok);
    if (inactiveButStocked.length) {
      console.log('   No ACTIVE store other than the nearest can ship the whole order, BUT');
      console.log('   ' + inactiveButStocked.map(v => `"${v.store.name_en}"`).join(', ') +
                  ' has the stock and is marked INACTIVE.');
      console.log('   → Mark that store Active (admin → Stores) and option ③ will offer it.');
    } else {
      console.log('   No other active store has enough AVAILABLE stock for every line.');
      console.log('   Availability = physical − safety_buffer − reservations, capped by the');
      console.log('   channel quota. Check the rows above for the store that has physical');
      console.log('   units but 0 available (a safety buffer, a live reservation, or a');
      console.log('   ' + CHANNEL + '_quota of 0 is the usual culprit).');
    }
  }
  bar();
  console.log('(read-only — nothing was modified)\n');
});
