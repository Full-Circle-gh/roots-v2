#!/usr/bin/env node
// READ-ONLY. Why is the Meituan queue holding, and when does it start pushing?
//
//   node scripts/diagnose_meituan_sync_window.js
//
// The Meituan daemon only pushes stock inside each store's SYNC WINDOW — its
// opening hours, widened at the front by the store's own "Sync starts ·
// 同步开始" time, or by the shared 2h default when that is blank. Outside it,
// pushes queue and nothing moves. That front edge exists for exactly the case
// §85 now depends on: the daemon's own comment says it is "what stops the
// morning's PRE-ORDERS being served stock that last moved yesterday".
//
// §102 SETTLED THE QUESTION THIS SCRIPT WAS WRITTEN TO ASK. The window no longer
// has to start early enough to cover the pre-order window: an OPEN pre-order
// window now opens the sync gate by itself (lib/batch-cadence preorderSyncOpen),
// so a queue holding while the window is open is a fault, not a schedule. The
// pre-order window's own start is a tenant setting now and defaults to midnight.
//
// What is left to read here is still worth reading: which stores are pushing
// right now and why, and how old the pending queue is.
//
// Reports each store's hours, its sync start, whether it is pushing right now,
// and how old the pending queue is. Mutates nothing.

const path = require('path');
const Database = require('@libsql/client');

const ROOT = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH, { readonly: true });
try {
  db.prepare('CREATE TABLE IF NOT EXISTS _ro_probe_msw (x INTEGER)').run();
  console.log('!! ABORT: connection accepted a write.'); process.exit(2);
} catch (e) { console.log('read-only proven\n'); }

const sh = require(path.join(ROOT, 'lib', 'store-hours.js'));
const cadence = require(path.join(ROOT, 'lib', 'batch-cadence.js'));
const businessDate = require(path.join(ROOT, 'lib', 'business-date.js'));

const now = new Date();
const tz = cadence.tzOf(db);
const p = businessDate.zoneParts(tz, now);
const hm = (min) => min == null ? '—' : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

console.log(`shop clock : ${p.ymd} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}  (${tz || 'Asia/Shanghai'})`);
const cfg = cadence.readCfg(db);
if (cfg) {
  const w = cadence.preorderWindow(db, { channel: 'meituan', now });
  console.log(`pre-order  : ${cfg.preorder_open_hour}:00 → ${cfg.lock_hour}:00   (right now: ${w.open ? 'OPEN' : 'shut — ' + w.reason})`);
  /* §102 — the arithmetic this script was written to do is now DONE BY THE
     DAEMON: an open pre-order window opens the sync gate on its own, so the
     rows below cannot be held by the hours while the window is open. The line
     stays because the two windows are still worth seeing side by side — a
     pre-order start LATER than the sync start means the store's own hours are
     what opened the gate that morning, which is a different answer to "why is
     this pushing now" and the one an operator will ask next. */
  console.log(`             (§102: an open pre-order window opens the sync gate on its own)`);
}
console.log(`default lead: ${sh.DEFAULT_PREOPEN_LEAD_MIN} min before opening when "Sync starts" is blank`);
console.log('='.repeat(84));

let codes = [];
try {
  codes = db.prepare(`SELECT DISTINCT store_code FROM meituan_product_map WHERE sync_enabled=1 ORDER BY store_code`)
            .all().map(r => r.store_code).filter(Boolean);
} catch (e) { console.log(e.message); }

console.log('\nstore      open   close  syncStart  → sync window        pushing now?');
for (const code of codes) {
  const hours = sh.storeHours(code);
  if (!hours) { console.log(`${code.padEnd(10)} (no hours configured — daemon treats as always open)`); continue; }
  const win = sh.syncWindow(hours, { leadMin: sh.DEFAULT_PREOPEN_LEAD_MIN, graceMin: 15 });
  // §102 — the same OR the daemon itself applies, so this column says what the
  // daemon would say rather than what the hours alone would.
  const open = sh.within(win, { openGraceMin: 0, closeGraceMin: 15, now })
            || cadence.preorderSyncOpen(db, { channel: 'meituan', now });
  console.log(`${code.padEnd(10)} ${hm(hours.open).padEnd(6)} ${hm(hours.close).padEnd(6)} ` +
              `${hm(hours.syncStart).padEnd(10)} → ${(hm(win.open) + '–' + hm(win.close)).padEnd(18)} ` +
              `${open ? 'YES' : 'no — queue holds'}`);
}

console.log('\npending Meituan pushes, by age');
try {
  const rows = db.prepare(`
    SELECT store_code,
           COUNT(*) AS n,
           MIN(created_at) AS oldest,
           MAX(created_at) AS newest
      FROM meituan_sync_queue WHERE status='pending'
     GROUP BY store_code ORDER BY n DESC
  `).all();
  if (!rows.length) console.log('   none pending');
  for (const r of rows) {
    console.log(`   ${String(r.store_code || '?').padEnd(10)} ${String(r.n).padStart(5)} pending   oldest ${r.oldest}   newest ${r.newest}`);
  }
  const fresh = db.prepare(`
    SELECT COUNT(*) n FROM meituan_sync_queue
     WHERE status='pending' AND created_at > datetime('now','-12 hours')`).get().n;
  console.log(`   ${fresh} of them queued in the last 12h`);
} catch (e) { console.log(`   ${e.message}`); }

console.log('\nlast successful pushes (newest first)');
try {
  const rows = db.prepare(`
    SELECT store_code, MAX(last_pushed_at) AS at, COUNT(*) n
      FROM meituan_product_map WHERE sync_enabled=1 AND last_pushed_at IS NOT NULL
     GROUP BY store_code ORDER BY at DESC`).all();
  for (const r of rows) console.log(`   ${String(r.store_code).padEnd(10)} last ${r.at}   (${r.n} mapped)`);
} catch (e) { console.log(`   ${e.message}`); }
console.log('\n' + '='.repeat(84));
