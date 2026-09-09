#!/usr/bin/env node
// READ-ONLY. Can the §85 pre-order window actually do anything on this box?
//
//   node scripts/diagnose_preorder_readiness.js
//
// The window publishes `shelf + preorder_qty` to Meituan, Eleme and gzgrocery
// on a batch morning, and every one of its conditions is an off switch. Before
// switching it on for a live shop, the useful question is not "is the code
// there" but "would it change anything, and on which listings" — which is a
// question about THIS database and nothing else:
//
//   1. is batch.schedule enabled, and what cadence does it name
//   2. is ready_hour set (§74's off switch, and lock_hour's fallback)
//   3. what do lock_hour / preorder_qty / preorder_channels hold TODAY
//   4. which products are is_batch_made — the only ones the window touches
//   5. which of those are actually MAPPED and sync-enabled per channel, because
//      a window over an unmapped product publishes to nothing
//   6. what their shelves read now, negatives included (§84)
//
// Mutates nothing, and proves it: the connection is opened readonly and a write
// is attempted before anything else runs.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH, { readonly: true });

// Prove the connection cannot write, rather than trusting the flag.
try {
  db.prepare('CREATE TABLE IF NOT EXISTS _ro_probe_preorder (x INTEGER)').run();
  console.log('!! ABORT: this connection accepted a write. Refusing to report.');
  process.exit(2);
} catch (e) {
  console.log(`read-only proven (${String(e.message).slice(0, 60)}…)\n`);
}

const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const cfg = (key) => {
  try {
    const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    return r ? JSON.parse(r.value_json) : null;
  } catch (_) { return null; }
};

console.log(`DB : ${DB_PATH}`);
console.log('='.repeat(78));

// ── 1-3 · the schedule as it stands ────────────────────────────────────────
const b = cfg('batch.schedule');
console.log('\n1 · batch.schedule');
if (!b) {
  console.log('   (no row) — the fresh batch schedule has never been saved.');
} else {
  const show = (k) => console.log(`   ${k.padEnd(20)} ${JSON.stringify(b[k])}`);
  for (const k of ['enabled', 'anchor_date', 'interval_days', 'cutoff_hour', 'ready_hour',
                   'lock_hour', 'preorder_qty', 'preorder_channels']) show(k);
  const skips = Array.isArray(b.skip_dates) ? b.skip_dates : [];
  console.log(`   ${'skip_dates'.padEnd(20)} ${skips.length} date(s)${skips.length ? ': ' + skips.join(', ') : ''}`);
}
console.log(`\n   fresh.rescheduleCutoffHour = ${JSON.stringify(cfg('fresh.rescheduleCutoffHour'))}`);
const tzRow = cfg('shop.timezone') || cfg('store.timezone') || cfg('timezone');
console.log(`   shop timezone config       = ${JSON.stringify(tzRow)}`);

// Which calendar days are batch days, from the anchor, for the next fortnight.
if (b && b.enabled && b.anchor_date) {
  const iv = Math.max(1, parseInt(b.interval_days, 10) || 2);
  const skip = new Set(Array.isArray(b.skip_dates) ? b.skip_dates : []);
  const anchor = new Date(`${b.anchor_date}T12:00:00Z`);
  const today = new Date();
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i, 12));
    const off = Math.round((d - anchor) / 86400000);
    if (off >= 0 && off % iv === 0) {
      const iso = d.toISOString().slice(0, 10);
      days.push(skip.has(iso) ? `${iso}(skipped)` : iso);
    }
  }
  console.log(`\n   next batch days (UTC approximation, next 14d): ${days.join(', ') || 'none'}`);
}

// ── 4 · the products the window can touch at all ───────────────────────────
console.log('\n2 · batch-made products (the ONLY ones the window touches)');
const fresh = db.prepare(`
  SELECT id, sku, name_en, name_cn, COALESCE(is_active,1) AS active, oos_policy
    FROM store_products
   WHERE COALESCE(is_batch_made,0) = 1
   ORDER BY COALESCE(is_active,1) DESC, id
`).all();
if (!fresh.length) {
  console.log('   NONE. Nothing is flagged is_batch_made — the window would publish nothing.');
} else {
  for (const p of fresh) {
    console.log(`   #${String(p.id).padEnd(5)} ${String(p.sku || '-').padEnd(10)} ` +
                `${String(p.name_en || p.name_cn || '?').slice(0, 30).padEnd(31)} ` +
                `${p.active ? 'active ' : 'ARCHIVED'} oos=${p.oos_policy || '-'}`);
  }
  console.log(`   ${fresh.length} total, ${fresh.filter(p => p.active).length} active`);
}

// ── 5-6 · mapped, enabled, and what the shelf says ─────────────────────────
const CHANNELS = [
  { key: 'meituan',   map: 'meituan_product_map' },
  { key: 'eleme',     map: 'eleme_product_map' },
  { key: 'gzgrocery', map: 'guanyi_product_map' },
];
console.log('\n3 · of those, which are MAPPED and sync-enabled per channel');
const activeFresh = fresh.filter((p) => p.active);
for (const ch of CHANNELS) {
  if (!has(ch.map)) { console.log(`   ${ch.key.padEnd(10)} (no ${ch.map} table)`); continue; }
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT m.product_id, m.retail_store_id, m.store_code,
             COALESCE(s.physical_qty, 0) AS shelf,
             p.sku, COALESCE(p.name_en, p.name_cn) AS name
        FROM ${ch.map} m
        JOIN store_products p ON p.id = m.product_id
        LEFT JOIN retail_store_stock s ON s.store_id = m.retail_store_id
                                      AND s.product_id = m.product_id
       WHERE m.sync_enabled = 1
         AND COALESCE(p.is_batch_made,0) = 1
         AND COALESCE(p.is_active,1) = 1
       ORDER BY m.store_code, p.sku
    `).all();
  } catch (e) { console.log(`   ${ch.key.padEnd(10)} query failed: ${e.message}`); continue; }
  console.log(`   ${ch.key.padEnd(10)} ${rows.length} fresh listing(s) live`);
  for (const r of rows) {
    console.log(`       ${String(r.store_code || '-').padEnd(10)} ${String(r.sku || '-').padEnd(10)} ` +
                `${String(r.name || '?').slice(0, 26).padEnd(27)} shelf=${r.shelf}` +
                `${r.shelf < 0 ? '  ← already in debt' : ''}`);
  }
}

// ── A negative shelf anywhere is worth seeing before switching anything on ──
console.log('\n4 · shelves already below zero (any product, §84)');
const neg = db.prepare(`
  SELECT s.store_id, s.product_id, s.physical_qty AS q, p.sku,
         COALESCE(p.name_en, p.name_cn) AS name, COALESCE(p.is_batch_made,0) AS fresh
    FROM retail_store_stock s JOIN store_products p ON p.id = s.product_id
   WHERE s.physical_qty < 0 ORDER BY s.physical_qty
`).all();
if (!neg.length) console.log('   none');
for (const r of neg) {
  console.log(`   store ${r.store_id} ${String(r.sku || '-').padEnd(10)} ` +
              `${String(r.name || '?').slice(0, 26).padEnd(27)} ${r.q}${r.fresh ? '  (fresh)' : ''}`);
}

// ── The verdict, in one place ──────────────────────────────────────────────
console.log('\n' + '='.repeat(78));
const problems = [];
if (!b || !b.enabled) problems.push('batch.schedule is not enabled — the window can never open');
if (b && b.enabled && !b.anchor_date) problems.push('no anchor_date — no cadence to compute batch days from');
if (b && b.ready_hour == null && b.lock_hour == null) {
  problems.push('neither ready_hour nor lock_hour is set — the window has no closing hour and stays shut');
}
if (!activeFresh.length) problems.push('no active is_batch_made products — nothing to publish for');
if (problems.length) {
  console.log('NOT READY:');
  for (const p of problems) console.log(`  • ${p}`);
} else {
  console.log('The schedule and the products are in place. What decides whether the');
  console.log('window is LIVE is preorder_qty and preorder_channels above.');
}
console.log('='.repeat(78));
