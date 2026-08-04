#!/usr/bin/env node
/**
 * Read-only JSON-money survey — pass 5: settle the unit of the two third-party
 * capture blobs (delivery_jobs.raw_order, meituan_sync_log.detail) by pairing
 * their amounts against the columns that hold the same transaction, and check
 * whether either is ever read back. Every statement is a SELECT; the connection
 * is opened read-only and PROVEN so.
 */
'use strict';
const Database = require('/root/roots-v2/node_modules/better-sqlite3');
const db = new Database(process.env.ROOTS_DB || '/root/roots-v2/data/roots.db', { readonly: true, fileMustExist: true });
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (e) { proven = true; console.log('read-only PROVEN — ' + e.message); }
if (!proven) { console.error('FATAL: write accepted'); process.exit(2); }

const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

console.log('\n══ delivery_jobs.raw_order vs retail_orders.total ══');
{
  const rows = db.prepare(`SELECT dj.id, dj.retail_order_id, dj.channel_name, dj.raw_order j,
                                  ro.order_no, ro.total, ro.shipping_fee
                             FROM delivery_jobs dj
                             LEFT JOIN retail_orders ro ON ro.id = dj.retail_order_id
                            WHERE dj.raw_order IS NOT NULL ORDER BY dj.id DESC`).all();
  let fen = 0, yuan = 0, none = 0, noOrder = 0, shown = 0;
  for (const r of rows) {
    let p; try { p = JSON.parse(r.j); } catch (e) { none++; continue; }
    const cands = ['orderAmount', 'payAmount', 'totalPrice', 'price'].map(k => [k, get(p, k)]).filter(([, v]) => typeof v === 'number');
    if (r.total == null) { noOrder++; if (shown < 6) { console.log(`   job ${r.id} channel=${r.channel_name} (no linked retail order) amounts=${JSON.stringify(cands)}`); shown++; } continue; }
    const t = Number(r.total);
    let verdict = 'none';
    for (const [, v] of cands) {
      if (Math.abs(v - t * 100) < 1) { verdict = 'fen'; break; }
      if (v !== 0 && Math.abs(v - t) < 0.01) { verdict = 'yuan'; break; }
    }
    if (verdict === 'fen') fen++; else if (verdict === 'yuan') yuan++; else none++;
    if (shown < 8) { console.log(`   job ${r.id} order ${r.order_no} col.total=${t} verdict=${verdict} amounts=${JSON.stringify(cands)}`); shown++; }
  }
  console.log(`   rows=${rows.length}  fen=${fen} yuan=${yuan} indeterminate=${none} unlinked=${noOrder}`);
}

console.log('\n══ meituan_sync_log.detail — what the sampled payload is ══');
{
  const n = db.prepare(`SELECT COUNT(*) n FROM meituan_sync_log WHERE detail LIKE '%orderInfo%'`).get().n;
  console.log(`   rows whose detail mentions orderInfo: ${n} of ${db.prepare('SELECT COUNT(*) n FROM meituan_sync_log').get().n}`);
  const evs = db.prepare(`SELECT event_type, COUNT(*) n FROM meituan_sync_log GROUP BY event_type ORDER BY n DESC LIMIT 12`).all();
  console.log('   event_type spread: ' + evs.map(e => `${e.event_type}:${e.n}`).join('  '));
  for (const r of db.prepare(`SELECT id, store_code, event_type, detail FROM meituan_sync_log
                               WHERE detail LIKE '%userPayTotalAmount%' ORDER BY id DESC LIMIT 3`).all()) {
    let p; try { p = JSON.parse(r.detail); } catch (e) { continue; }
    const oi = get(p, 'sample.orderInfo');
    let o; try { o = typeof oi === 'string' ? JSON.parse(oi) : oi; } catch (e) { o = null; }
    const wmId = get(p, 'sample.commonInfo') && (typeof get(p, 'sample.commonInfo') === 'string'
      ? JSON.parse(get(p, 'sample.commonInfo')).wmOrderViewId : get(p, 'sample.commonInfo').wmOrderViewId);
    const pay = o && get(o, 'chargeInfo.userPayTotalAmount');
    let mo = null;
    if (wmId) mo = db.prepare('SELECT order_id, customer_paid, product_total FROM meituan_orders WHERE order_id = ?').get(String(wmId));
    console.log(`   log ${r.id} ${r.event_type} wmOrderViewId=${wmId} payload.userPayTotalAmount=${pay}`
      + `  meituan_orders row=${mo ? JSON.stringify(mo) : 'not found'}`);
  }
}

console.log('\n══ is either blob ever read back? (schema-level check) ══');
console.log('   delivery_jobs columns: ' + db.prepare('PRAGMA table_info(delivery_jobs)').all().map(c => c.name).join(','));
console.log('   meituan_sync_log columns: ' + db.prepare('PRAGMA table_info(meituan_sync_log)').all().map(c => c.name).join(','));

console.log('\n══ products.bundle (legacy kitchen table) ══');
for (const r of db.prepare(`SELECT id, name_en, bundle FROM products WHERE bundle IS NOT NULL AND TRIM(bundle) <> ''`).all()) {
  console.log(`   product ${r.id} ${r.name_en} bundle=${String(r.bundle).slice(0, 220)}`);
}

console.log('\n══ storefront_config bundle_price / seed_entries context ══');
for (const r of db.prepare(`SELECT key, value_json FROM storefront_config
   WHERE value_json LIKE '%bundle_price%' OR value_json LIKE '%seed_entries%'`).all()) {
  console.log(`   ${r.key} = ${String(r.value_json).slice(0, 320)}`);
}

console.log('\nRESULT=SURVEY5_COMPLETE');
db.close();
