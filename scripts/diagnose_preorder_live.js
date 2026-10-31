#!/usr/bin/env node
// READ-ONLY. Is the §85 pre-order window doing its job RIGHT NOW?
//
//   node scripts/diagnose_preorder_live.js
//
// Run on a batch morning, this answers the only questions that matter on the
// first live day:
//
//   1. does the tenant's clock agree it is a batch day, and is the window open
//   2. for each fresh listing: what is on the shelf, what WOULD we publish, and
//      what did the channel last actually accept — the three can disagree, and
//      which pair disagrees says whether the fault is ours or the push's
//   3. what the kitchen is being told it owes
//   4. whether anything is parked waiting
//
// Mutates nothing, and proves it before reporting.

const path = require('path');
const Database = require('@libsql/client');

const ROOT = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH, { readonly: true });

try {
  db.prepare('CREATE TABLE IF NOT EXISTS _ro_probe_live (x INTEGER)').run();
  console.log('!! ABORT: this connection accepted a write.');
  process.exit(2);
} catch (e) { console.log('read-only proven\n'); }

const cadence      = require(path.join(ROOT, 'lib', 'batch-cadence.js'));
const publish      = require(path.join(ROOT, 'lib', 'channel-publish.js'));
const bundleStock  = require(path.join(ROOT, 'lib', 'bundle-stock.js'));
const businessDate = require(path.join(ROOT, 'lib', 'business-date.js'));

const now = new Date();
const tz = cadence.tzOf(db);
const parts = businessDate.zoneParts(tz, now);
const cfg = cadence.readCfg(db);

console.log(`DB    : ${DB_PATH}`);
console.log(`now   : ${now.toISOString()}  (UTC)`);
console.log(`shop  : ${parts.ymd} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}  tz=${tz || '(unset → Asia/Shanghai)'}`);
console.log('='.repeat(86));

// ── 1 · the window ─────────────────────────────────────────────────────────
console.log('\n1 · the window');
if (!cfg) {
  console.log('   no usable batch.schedule — everything below is the plain shelf.');
} else {
  console.log(`   cadence      every ${cfg.interval_days}d from ${cfg.anchor_date}`);
  console.log(`   hours        ready=${cfg.ready_hour}  lock=${cfg.lock_hour}  cutoff=${cfg.cutoff_hour}`);
  console.log(`   allowance    ${cfg.preorder_qty}   channels: ${cfg.preorder_channels.join(', ') || '(none)'}`);
  const nextDay = cadence.nextBatchDate(now, cfg, tz);
  console.log(`   next batch   ${nextDay}${nextDay === parts.ymd ? '   ← TODAY IS A BATCH DAY' : ''}`);
}
const CH = ['meituan', 'eleme', 'gzgrocery'];
const windows = {};
for (const c of CH) {
  const w = cadence.preorderWindow(db, { channel: c, now });
  windows[c] = w;
  console.log(`   ${c.padEnd(10)} ${w.open ? `OPEN  (allowance ${w.qty}, closes ${w.lock_hour}:00)` : `shut  — ${w.reason}`}`);
}

// ── 2 · shelf vs what we would publish vs what the channel holds ───────────
console.log('\n2 · per fresh listing — shelf | would publish | channel last accepted');
const MAPS = [
  { key: 'meituan',   map: 'meituan_product_map' },
  { key: 'eleme',     map: 'eleme_product_map' },
  { key: 'gzgrocery', map: 'guanyi_product_map' },
];
for (const m of MAPS) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT x.retail_store_id AS store_id, x.product_id, x.store_code,
             x.last_pushed_qty AS pushed, x.last_pushed_at AS pushed_at,
             p.sku, COALESCE(p.name_en, p.name_cn) AS name
        FROM ${m.map} x JOIN store_products p ON p.id = x.product_id
       WHERE x.sync_enabled = 1
         AND COALESCE(p.is_batch_made,0) = 1 AND COALESCE(p.is_active,1) = 1
       ORDER BY x.store_code, p.sku
    `).all();
  } catch (e) { console.log(`   ${m.key}: ${e.message}`); continue; }
  console.log(`\n   ── ${m.key} (window ${windows[m.key].open ? 'OPEN' : 'shut'}) ──`);
  if (!rows.length) { console.log('      no live fresh listings'); continue; }
  for (const r of rows) {
    const shelf = bundleStock.unflooredSellableAt(db, r.store_id, r.product_id);
    const want = publish.publishableAt(db, r.store_id, r.product_id,
      { channel: m.key, now, window: windows[m.key] });
    const agree = r.pushed != null && Number(r.pushed) === Number(want);
    console.log(`      ${String(r.store_code || '-').padEnd(9)} ${String(r.sku || '-').padEnd(8)} ` +
                `${String(r.name || '?').slice(0, 24).padEnd(25)} ` +
                `shelf ${String(shelf).padStart(4)} | publish ${String(want).padStart(4)} | ` +
                `channel ${String(r.pushed == null ? '—' : r.pushed).padStart(4)} ` +
                `${agree ? 'ok' : '  ← MISMATCH'}  ${r.pushed_at || ''}`);
  }
}

// ── 3 · the queue behind those numbers ─────────────────────────────────────
console.log('\n3 · push queues');
for (const m of [['meituan', 'meituan_sync_queue'], ['eleme', 'eleme_sync_queue'], ['gzgrocery', 'guanyi_sync_queue']]) {
  try {
    const rows = db.prepare(`SELECT status, COUNT(*) n FROM ${m[1]} GROUP BY status`).all();
    console.log(`   ${m[0].padEnd(10)} ${rows.map(r => `${r.status}=${r.n}`).join('  ') || '(empty)'}`);
  } catch (e) { console.log(`   ${m[0].padEnd(10)} ${e.message}`); }
}

// ── 4 · what the kitchen is being told ─────────────────────────────────────
console.log('\n4 · what the kitchen owes (§84)');
try {
  const owed = require(path.join(ROOT, 'lib', 'batch-owed.js')).owedAt(db);
  if (!owed.length) console.log('   nothing owed');
  for (const o of owed) {
    console.log(`   store ${o.store_id} ${String(o.name_en || o.name_cn || '?').slice(0, 26).padEnd(27)} ` +
                `owed ${String(o.owed).padStart(4)}  (shelf ${o.from_shelf}, parked ${o.from_parked})`);
  }
} catch (e) { console.log(`   ${e.message}`); }

console.log('\n5 · orders parked waiting on a batch');
try {
  const n = db.prepare("SELECT COUNT(*) n FROM retail_orders WHERE status='awaiting_restock'").get().n;
  console.log(`   ${n} awaiting_restock order(s)`);
} catch (e) { console.log(`   ${e.message}`); }

console.log('\n6 · today\'s channel orders so far');
try {
  const rows = db.prepare(`
    SELECT COALESCE(channel,'?') AS ch, COUNT(*) n
      FROM retail_orders
     WHERE DATE(COALESCE(paid_at, placed_at)) >= DATE('now','-1 day')
     GROUP BY ch ORDER BY n DESC
  `).all();
  console.log(`   ${rows.map(r => `${r.ch}=${r.n}`).join('  ') || '(none in 24h)'}`);
} catch (e) { console.log(`   ${e.message}`); }
console.log('\n' + '='.repeat(86));
