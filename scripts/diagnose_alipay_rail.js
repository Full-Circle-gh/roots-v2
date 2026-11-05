#!/usr/bin/env node
/**
 * How is Alipay actually paid at Roots, and could Alipay money be kept on a
 * cancelled order the way WeChat money was (§479)? READ-ONLY survey.
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_alipay_rail.js
 *
 * Why it exists. §479 closed the WeChat gap: a charge that outlived its order,
 * and a callback that answered "OK" to money it could not place. The Alipay
 * callback has the same shape (it settles only a 'pending' row). But Alipay has
 * two rails and it is not known which one is used:
 *   • the API rail (当面付 precreate, wap and page pay) — settled by the
 *     callback, and the only rail the gap applies to. The code says its API
 *     access has been blocked;
 *   • the manual rail — a static QR, a screenshot, staff mark it paid. No
 *     callback, no charge to expire, nothing to auto-refund.
 * Building the WeChat fix again for a rail nobody pays through would be code
 * that guards nothing, so this is asked first.
 *
 * It prints:
 *   1. whether each rail is switched on (yes/no only — no secret is printed);
 *   2. Alipay payments by rail: how many, when the last one was, by status;
 *   3. the same gap: cancelled orders with an Alipay API charge raised and no
 *      refund recorded (the list to check by hand in the Alipay merchant site).
 *
 * It writes nothing and calls nothing outside the box. The database is opened
 * read-only and that is PROVEN by attempting a write.
 */
'use strict';

const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const ENV_PATH = process.env.ROOTS_ENV || '/root/roots-v2/.env';

// Alipay API-rail rows: the pay-create paths stamp the FC-prefixed
// out_trade_no on the row (alipayOutTradeNo); a manual-rail order never gets one.
const API_ROWS_SQL = `
  SELECT p.status AS payment_status, o.status AS order_status, COUNT(*) AS n,
         SUM(CASE WHEN p.transaction_id IS NOT NULL OR p.raw_callback_json IS NOT NULL THEN 1 ELSE 0 END) AS with_callback,
         MAX(o.placed_at) AS last_placed
    FROM retail_payments p JOIN retail_orders o ON o.id = p.order_id
   WHERE p.method = 'alipay' AND p.out_trade_no LIKE 'FC%'
   GROUP BY p.status, o.status
   ORDER BY n DESC`;

// The gap itself, if the API rail was ever used: cancelled, a charge raised,
// no refund recorded.
const API_GAP_SQL = `
  SELECT o.order_no, o.placed_at, o.cancelled_at, o.cancelled_reason, p.status AS payment_status,
         p.amount, p.out_trade_no
    FROM retail_payments p JOIN retail_orders o ON o.id = p.order_id
   WHERE p.method = 'alipay' AND p.out_trade_no LIKE 'FC%'
     AND o.status = 'cancelled' AND COALESCE(p.status, '') <> 'refunded'
   ORDER BY o.placed_at ASC`;

// Manual-rail orders: a screenshot was uploaded.
const MANUAL_ROWS_SQL = `
  SELECT o.status AS order_status, COUNT(*) AS n, MAX(o.placed_at) AS last_placed
    FROM retail_orders o
   WHERE o.payment_method = 'alipay' AND o.alipay_proof_image IS NOT NULL
   GROUP BY o.status
   ORDER BY n DESC`;

// Every order whose chosen tender is Alipay, whatever happened to it.
const ALL_ALIPAY_SQL = `
  SELECT COUNT(*) AS n, MIN(placed_at) AS first_placed, MAX(placed_at) AS last_placed,
         SUM(CASE WHEN placed_at >= datetime('now', '-90 days') THEN 1 ELSE 0 END) AS last_90d
    FROM retail_orders WHERE payment_method = 'alipay'`;

function bj(s) {
  if (!s) return '—';
  const t = Date.parse(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return Number.isFinite(t) ? new Date(t + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : String(s);
}

function main() {
  const Database = require(path.join(HOME, 'node_modules', 'better-sqlite3'));
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
  if (!proven) { console.error('FATAL: the connection accepted a write. Aborting.'); process.exit(2); }

  // 1. Which rails are on. The API rail is on when the app's own test passes
  //    (routes/retail.js: ALIPAY_DEV_MODE = !ALIPAY_APP_ID || !ALIPAY_PRIVATE_KEY).
  const { loadEnv } = require(path.join(HOME, 'lib', 'load-env'));
  const env = loadEnv({ path: ENV_PATH });
  const has = (k) => !!(process.env[k] && String(process.env[k]).trim());
  let manual = null;
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'integrations.alipayManual'").get();
    const v = row ? JSON.parse(row.value_json) : null;
    manual = { saved: !!row, enabled: !!(v && v.enabled), hasQr: !!(v && v.qr), windowMin: v && Number(v.timeWindowMin) > 0 ? Number(v.timeWindowMin) : 0 };
  } catch (e) { manual = { error: e.message }; }

  console.log('\n══ 1. Which Alipay rails are switched on ══');
  console.log(`  .env read: ${env.sourced ? 'yes' : 'NO (' + ENV_PATH + ' not found)'}`);
  console.log(`  API rail (当面付): ALIPAY_APP_ID ${has('ALIPAY_APP_ID') ? 'set' : 'missing'} · ALIPAY_PRIVATE_KEY ${has('ALIPAY_PRIVATE_KEY') ? 'set' : 'missing'} · ALIPAY_PUBLIC_KEY ${has('ALIPAY_PUBLIC_KEY') ? 'set' : 'missing'}`);
  console.log(`    → ${has('ALIPAY_APP_ID') && has('ALIPAY_PRIVATE_KEY') ? 'ON (but checkout uses the manual QR first whenever it is enabled)' : 'OFF'}`);
  console.log(`  Manual rail (static QR + screenshot): ${manual.error ? 'unreadable: ' + manual.error
    : `saved ${manual.saved ? 'yes' : 'no'} · enabled ${manual.enabled ? 'yes' : 'no'} · QR ${manual.hasQr ? 'yes' : 'no'} · pay window ${manual.windowMin || 'none'} min`}`);
  console.log(`    → ${manual.enabled && manual.hasQr ? 'ON — and it takes priority over the API rail at checkout' : 'OFF'}`);

  console.log('\n══ 2. Alipay orders and payments ══');
  const all = db.prepare(ALL_ALIPAY_SQL).get();
  console.log(`  every order with Alipay chosen: ${all.n} (last 90 days: ${all.last_90d || 0}) · first ${bj(all.first_placed)} · last ${bj(all.last_placed)}`);
  const api = db.prepare(API_ROWS_SQL).all();
  const apiTotal = api.reduce((s, r) => s + r.n, 0);
  console.log(`  API-rail payment rows (a charge was raised with Alipay): ${apiTotal}`);
  api.forEach((r) => console.log(`    payment ${r.payment_status} · order ${r.order_status}: ${r.n} (callback landed on ${r.with_callback}) · last ${bj(r.last_placed)}`));
  const man = db.prepare(MANUAL_ROWS_SQL).all();
  const manTotal = man.reduce((s, r) => s + r.n, 0);
  console.log(`  manual-rail orders (screenshot uploaded): ${manTotal}`);
  man.forEach((r) => console.log(`    order ${r.order_status}: ${r.n} · last ${bj(r.last_placed)}`));

  console.log('\n══ 3. The §479 gap on Alipay: cancelled, charge raised, no refund recorded ══');
  const gap = db.prepare(API_GAP_SQL).all();
  if (!gap.length) console.log('  none');
  gap.forEach((r) => console.log(`  ${r.order_no}  placed ${bj(r.placed_at)}  cancelled ${bj(r.cancelled_at)} (${r.cancelled_reason || '—'})  our row: ${r.payment_status} ¥${Number(r.amount).toFixed(2)}  ${r.out_trade_no}`));
  if (gap.length) console.log('  → check each in the Alipay merchant site; this survey does not ask Alipay.');

  db.close();
  console.log('\nNothing was written and nothing outside this box was called.');
}

if (require.main === module) main();

module.exports = { API_ROWS_SQL, API_GAP_SQL, MANUAL_ROWS_SQL, ALL_ALIPAY_SQL, bj };
