#!/usr/bin/env node
/**
 * Review the gzgrocery pickup SHADOW observer's findings.
 *
 * The daemon (GUANYI_PICKUP_MODE=shadow) infers gzgrocery pickups from drops in
 * their Guanyi salableQty and logs what it WOULD decrement from Tianhe — without
 * touching real stock. This prints those inferences so you can compare them
 * against what gzgrocery actually picked up, to validate the model before going
 * live. Read-only.
 *
 * Run ON THE SERVER:
 *   node scripts/guanyi-pickup-report.js            # last 24h summary + recent rows
 *   node scripts/guanyi-pickup-report.js --hours 72
 *   node scripts/guanyi-pickup-report.js --all      # every action incl. resync/init
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const argv = process.argv.slice(2);
const hi = argv.indexOf('--hours');
const HOURS = hi >= 0 && argv[hi + 1] ? Number(argv[hi + 1]) : 24;
const ALL = argv.includes('--all');

const db = new Database(path.join(__dirname, '..', 'data', 'roots.db'), { readonly: true });
if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='guanyi_pickup_log'`).get()) {
  console.log('guanyi_pickup_log not found — daemon has not run with the pickup observer yet.'); process.exit(0);
}

const since = `-${HOURS} hours`;
console.log(`\nGuanyi pickup observer — last ${HOURS}h`);
console.log('═'.repeat(72));

const tally = db.prepare(`SELECT action, COUNT(*) n, COALESCE(SUM(inferred_pickup),0) units
                            FROM guanyi_pickup_log WHERE created_at >= datetime('now', ?) GROUP BY action ORDER BY n DESC`).all(since);
console.log('\nBy action:');
for (const t of tally) console.log(`  ${String(t.action).padEnd(16)} ${String(t.n).padStart(4)} rows   ${t.units ? `(${t.units} units)` : ''}`);

const pickups = db.prepare(`
  SELECT COUNT(*) events, COALESCE(SUM(inferred_pickup),0) units, COUNT(DISTINCT product_id) skus
    FROM guanyi_pickup_log
   WHERE action IN ('would_decrement','decremented') AND created_at >= datetime('now', ?)`).get(since);
console.log(`\nInferred PICKUPS: ${pickups.events} event(s), ${pickups.units} unit(s) across ${pickups.skus} product(s).`);

console.log('\nTop products by inferred pickup units:');
const top = db.prepare(`
  SELECT guanyi_name, product_id, COUNT(*) events, COALESCE(SUM(inferred_pickup),0) units
    FROM guanyi_pickup_log
   WHERE action IN ('would_decrement','decremented') AND created_at >= datetime('now', ?)
   GROUP BY product_id ORDER BY units DESC LIMIT 20`).all(since);
if (!top.length) console.log('  (none yet — either no gzgrocery sales in window, or baselines still warming up)');
for (const r of top) console.log(`  ${String(r.units).padStart(4)} u  (${r.events}×)  #${r.product_id} ${r.guanyi_name || ''}`);

const capped = db.prepare(`SELECT guanyi_name, observed_qty, baseline_qty, inferred_pickup, tianhe_qty, created_at
                             FROM guanyi_pickup_log WHERE action='capped' AND created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 20`).all(since);
if (capped.length) {
  console.log(`\n⚠️  CAPPED (suspiciously large drops, NOT applied — review):`);
  for (const r of capped) console.log(`  ${r.created_at}  ${r.guanyi_name}  baseline ${r.baseline_qty}→${r.observed_qty} (drop ${r.inferred_pickup}, Tianhe ${r.tianhe_qty})`);
}

console.log('\nRecent events:');
const filter = ALL ? '' : `AND action IN ('would_decrement','decremented','capped','drift_up')`;
const rows = db.prepare(`SELECT created_at, action, guanyi_name, baseline_qty, observed_qty, drift, inferred_pickup
                           FROM guanyi_pickup_log WHERE created_at >= datetime('now', ?) ${filter} ORDER BY id DESC LIMIT 40`).all(since);
for (const r of rows) {
  console.log(`  ${r.created_at}  ${String(r.action).padEnd(15)} ${(r.guanyi_name||'').slice(0,34).padEnd(34)} ${r.baseline_qty}→${r.observed_qty} (${r.drift>0?'+':''}${r.drift})${r.inferred_pickup?`  pickup=${r.inferred_pickup}`:''}`);
}
console.log('');
db.close();
