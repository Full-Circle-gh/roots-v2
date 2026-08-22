#!/usr/bin/env node
/**
 * diagnose_stock_queue.js — why is the Meituan stock push queue not draining?
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_stock_queue.js
 *
 * READ-ONLY, and it proves that on the connection before reading anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * A queue row can be invisible to BOTH mechanisms that are supposed to move it,
 * and nothing in the product says so. The drain reads
 *
 *     status='pending' AND attempts < 3
 *
 * and the drift sweep — the level-triggered backstop that exists precisely to
 * rescue rows the drain gave up on — skips any target that has a row in
 *
 *     status IN ('pending','processing')
 *
 * So a row left pending with attempts >= 3 is skipped by the drain because of
 * its attempts, and blocks its own rescue because of its status. It is not an
 * error row, so it raises nothing; it is a pending row, so the operator's queue
 * tile counts it as ordinary backlog. Stock for that product simply stops.
 *
 * This prints the two numbers that distinguish "busy" from "wedged": how many
 * pending rows the drain can actually see, and how many it can never see again.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP = process.env.ROOTS_APP || '/root/roots-v2';
const STORE = process.env.QUEUE_DIAG_STORE || 'tianhe';
const ATTEMPT_CAP = 3;   // the daemon's `attempts < 3` drain window

let Database;
try { Database = require(path.join(APP, 'node_modules', 'better-sqlite3')); }
catch (e) { console.error('cannot load better-sqlite3: ' + e.message); process.exit(2); }

function candidates() {
  const list = [path.join(APP, 'data', 'roots.db')];
  try {
    const d = path.join(APP, 'data', 'tenants');
    for (const f of fs.readdirSync(d)) if (f.endsWith('.db')) list.push(path.join(d, f));
  } catch (_) { /* single tenant */ }
  return list.filter(f => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } });
}

const ago = (t) => {
  if (!t) return 'never';
  const ms = Date.now() - (Date.parse(String(t).replace(' ', 'T') + (String(t).includes('Z') ? '' : 'Z')) || 0);
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
};

let examined = 0;
for (const file of candidates()) {
  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (_) { continue; }
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (_) { proven = true; }
  if (!proven) { console.error(`FATAL: ${file} accepted a write — reading nothing`); try { db.close(); } catch (_) {} continue; }

  const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (_) { return []; } };
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) || null; } catch (_) { return null; } };
  const has = (t) => !!one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", t);
  if (!has('meituan_sync_queue')) { try { db.close(); } catch (_) {} continue; }

  const rows = one('SELECT COUNT(*) n FROM meituan_sync_queue WHERE store_code=?', STORE);
  if (!rows || !rows.n) { try { db.close(); } catch (_) {} continue; }
  examined++;

  console.log(`\n${file}  ·  store ${STORE}`);
  console.log('='.repeat(60));

  console.log('\nBy status:');
  for (const r of all('SELECT status, COUNT(*) n, MIN(created_at) oldest, MAX(created_at) newest FROM meituan_sync_queue WHERE store_code=? GROUP BY status ORDER BY n DESC', STORE)) {
    console.log(`  ${String(r.status).padEnd(12)} ${String(r.n).padStart(5)}   oldest ${ago(r.oldest)}, newest ${ago(r.newest)}`);
  }

  // The whole question, in two numbers.
  console.log('\nPending rows — can the drain still see them?');
  const drainable = one("SELECT COUNT(*) n, MIN(created_at) oldest FROM meituan_sync_queue WHERE store_code=? AND status='pending' AND attempts < ?", STORE, ATTEMPT_CAP);
  const stranded  = one("SELECT COUNT(*) n, MIN(created_at) oldest, MAX(attempts) worst FROM meituan_sync_queue WHERE store_code=? AND status='pending' AND attempts >= ?", STORE, ATTEMPT_CAP);
  console.log(`  drain-visible (attempts < ${ATTEMPT_CAP}): ${drainable ? drainable.n : 0}` +
              (drainable && drainable.n ? `, oldest ${ago(drainable.oldest)}` : ''));
  console.log(`  STRANDED (attempts >= ${ATTEMPT_CAP}):     ${stranded ? stranded.n : 0}` +
              (stranded && stranded.n ? `, oldest ${ago(stranded.oldest)}, worst attempts=${stranded.worst}` : ''));
  if (stranded && stranded.n) {
    console.log('  ↑ these are invisible to the drain (attempts) AND block the drift');
    console.log('    sweep from rescuing their product (status pending = "in flight").');
  }

  const processing = one("SELECT COUNT(*) n, MIN(created_at) oldest FROM meituan_sync_queue WHERE store_code=? AND status='processing'", STORE);
  if (processing && processing.n) console.log(`  orphaned 'processing': ${processing.n}, oldest ${ago(processing.oldest)}`);

  console.log('\nAttempts spread across pending rows:');
  for (const r of all("SELECT attempts, COUNT(*) n FROM meituan_sync_queue WHERE store_code=? AND status='pending' GROUP BY attempts ORDER BY attempts", STORE)) {
    console.log(`  attempts=${r.attempts}: ${r.n}`);
  }

  console.log('\nWhy they stopped (most common last_error on pending rows):');
  for (const r of all("SELECT COALESCE(last_error,'(none)') e, COUNT(*) n, MAX(created_at) newest FROM meituan_sync_queue WHERE store_code=? AND status='pending' GROUP BY e ORDER BY n DESC LIMIT 6", STORE)) {
    console.log(`  ${String(r.n).padStart(4)} × ${String(r.e).slice(0, 110)}   (newest ${ago(r.newest)})`);
  }

  const lastDone = one("SELECT MAX(processed_at) t FROM meituan_sync_queue WHERE store_code=? AND status='done'", STORE);
  console.log(`\nLast row that actually landed on Meituan: ${lastDone ? ago(lastDone.t) : 'never'}`);

  // Distinct products behind the backlog — the operator-facing size of it.
  const targets = one("SELECT COUNT(DISTINCT COALESCE('b'||bundle_id,'p'||product_id)) n FROM meituan_sync_queue WHERE store_code=? AND status='pending'", STORE);
  if (targets) console.log(`Distinct products/bundles waiting: ${targets.n}`);

  // ── The window the drain actually reads ──────────────────────────────────
  // The drain is not per-store. It takes the 40 oldest pending rows across EVERY
  // store, then drops the ones belonging to a store this daemon does not own
  // (SKIP_STORES — yuexiu is handled by 闪购/shangou-sync). Nothing re-runs the
  // query afterwards, so if rows from a skipped store fill that window, the
  // batch does nothing and the very same rows fill it again on the next cycle,
  // forever. The store this daemon DOES own never gets a turn, and its rows sit
  // at attempts=0 with no error — untouched rather than failed.
  console.log('\n\nPending across ALL stores (the drain reads one shared window):');
  for (const r of all("SELECT store_code, COUNT(*) n, MIN(created_at) oldest FROM meituan_sync_queue WHERE status='pending' GROUP BY store_code ORDER BY oldest")) {
    console.log(`  ${String(r.store_code).padEnd(12)} ${String(r.n).padStart(5)} pending, oldest ${ago(r.oldest)}`);
  }

  const WINDOW = 40;   // the drain's LIMIT
  console.log(`\nComposition of the drain's next ${WINDOW}-row window (oldest first):`);
  const win = all(`SELECT store_code, COUNT(*) n FROM (
                     SELECT store_code FROM meituan_sync_queue
                      WHERE status='pending' AND attempts < ?
                      ORDER BY created_at LIMIT ${WINDOW}
                   ) GROUP BY store_code ORDER BY n DESC`, ATTEMPT_CAP);
  for (const r of win) console.log(`  ${String(r.store_code).padEnd(12)} ${String(r.n).padStart(3)} of ${WINDOW}`);
  const mine = win.find(r => r.store_code === STORE);
  if (!mine) {
    console.log(`  → ${STORE} holds NONE of the window: every cycle reads the same rows`);
    console.log(`    belonging to another store and does nothing. Head-of-line blocked.`);
  } else if (mine.n < WINDOW) {
    console.log(`  → ${STORE} holds ${mine.n} of ${WINDOW}; the rest belong to other stores.`);
  }

  try { db.close(); } catch (_) {}
}

if (!examined) console.log(`no database on this box holds ${STORE} queue rows`);
console.log('');
