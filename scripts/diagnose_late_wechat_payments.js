#!/usr/bin/env node
/**
 * Which cancelled orders did WeChat actually take money for? READ-ONLY (§478).
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_late_wechat_payments.js
 *   or, on the server:  node scripts/diagnose_late_wechat_payments.js
 *
 * Why it exists. Until §478 a WeChat charge stayed payable after the order was
 * cancelled, and a payment that landed then was answered "OK" by our callback
 * and kept, with nobody told. TC001211 (2026-10-15) was the one a customer
 * complained about. This finds any others.
 *
 * What it does:
 *   1. Reads every CANCELLED order whose payment row shows a WeChat charge was
 *      raised (an FC… out_trade_no) and whose row does not already say the
 *      money went back ('refunded').
 *   2. Asks WeChat for each one's real state (GET the transaction by
 *      out_trade_no) — one call per order, a pause between calls.
 *   3. Prints three lists: PAID AND KEPT (refund these), ALREADY REFUNDED on
 *      WeChat's side (by hand, as TC001211 was), and the rest (never paid).
 *
 * It writes NOTHING and refunds NOTHING. The database is opened read-only and
 * that is PROVEN by attempting a write and aborting if it is accepted. WeChat
 * is only asked questions (GET); no charge, refund or close is ever sent.
 * Secrets are read from the server's .env and never printed.
 *
 * Times are printed in Beijing time.
 *
 * Scope: the Roots account only (the main database and the .env merchant).
 * Other accounts keep their own databases and merchants and are not checked;
 * the count of them is printed so that is never silent.
 */
'use strict';

const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const ENV_PATH = process.env.ROOTS_ENV || '/root/roots-v2/.env';
const PAUSE_MS = 250;

// The rows worth asking WeChat about. Pure SQL so the suite can run it against
// the real table shapes. A row is a candidate when:
//   • its order is cancelled — the only state in which a payment can be kept
//     without anyone seeing it;
//   • a charge was actually raised: the out_trade_no carries the FC prefix the
//     pay-create paths stamp (the order-create placeholder is the bare
//     order_no, which never reached WeChat);
//   • the row does not already record the money going back.
const CANDIDATES_SQL = `
  SELECT o.id AS order_id, o.order_no, o.placed_at, o.cancelled_at, o.cancelled_reason,
         o.total, p.id AS payment_id, p.status AS payment_status, p.amount,
         COALESCE(p.refunded_amount, 0) AS refunded_amount, p.out_trade_no
    FROM retail_orders o
    JOIN retail_payments p ON p.order_id = o.id
   WHERE o.status = 'cancelled'
     AND p.out_trade_no LIKE 'FC%'
     AND COALESCE(p.status, '') <> 'refunded'
   ORDER BY o.placed_at ASC, p.id ASC`;

// WeChat's trade_state → which list it belongs on. Pure.
//   SUCCESS  the money is with the merchant and nothing has gone back
//   REFUND   at least one refund has been made against it (转入退款)
//   anything else — NOTPAY, CLOSED, REVOKED, USERPAYING, PAYERROR, not found —
//   means no money is being held
function classify(tradeState) {
  if (tradeState === 'SUCCESS') return 'kept';
  if (tradeState === 'REFUND') return 'refunded';
  return 'not_paid';
}

// One row per out_trade_no: two payment rows for one order share the charge.
function uniqueByTrade(rows) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.out_trade_no) ? false : (seen.add(r.out_trade_no), true)));
}

const money = (n) => '¥' + Number(n || 0).toFixed(2);
// Our timestamps are stored UTC; the shop reads Beijing time.
function bj(s) {
  if (!s) return '?';
  const t = Date.parse(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return Number.isFinite(t) ? new Date(t + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : String(s);
}

async function main() {
  const Database = require(path.join(HOME, 'node_modules', 'better-sqlite3'));

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; console.log('read-only PROVEN — write rejected: ' + e.message); }
  if (!proven) { console.error('FATAL: the connection accepted a write. Aborting.'); process.exit(2); }
  console.log('db: ' + DB_PATH);

  // The merchant, from the server's .env, the same variables the app reads for
  // the Roots account. Loaded through the app's own loader, never echoed.
  const { loadEnv } = require(path.join(HOME, 'lib', 'load-env'));
  const env = loadEnv({ path: ENV_PATH });
  if (!env.sourced) { console.error(`FATAL: ${ENV_PATH} not found — cannot reach WeChat without the merchant.`); process.exit(2); }

  // lib/payment-gateways is loaded for its signer, not run as the app. Its
  // neighbours would open the database for writing on load (tenant-creds
  // creates a table), so they are replaced in the module cache with the four
  // values the signer's module needs at load. Nothing below calls them.
  const stub = (rel, exp) => {
    const abs = path.join(HOME, rel);
    require.cache[abs] = { id: abs, filename: abs, path: path.dirname(abs), loaded: true, children: [], paths: [], exports: exp };
  };
  stub('lib/tenant-db.js', { currentTenantId: () => 1, ROOTS_TENANT_ID: 1 });
  stub('lib/tenant-creds.js', { getTenantCreds: () => { throw new Error('not used by this diagnostic'); } });
  stub('lib/tenant-brand.js', { tenantBrandLabel: () => 'Roots' });
  const gw = require(path.join(HOME, 'lib', 'payment-gateways'));

  const pay = {
    mchId: process.env.WECHAT_PAY_MCH_ID || '',
    serialNo: process.env.WECHAT_PAY_SERIAL_NO || '',
    privateKey: gw.normalizePem(process.env.WECHAT_PAY_PRIVATE_KEY || '', 'PRIVATE KEY'),
  };
  if (!pay.mchId || !pay.serialNo || !pay.privateKey) {
    console.error('FATAL: WECHAT_PAY_MCH_ID / WECHAT_PAY_SERIAL_NO / WECHAT_PAY_PRIVATE_KEY are not all set in ' + ENV_PATH);
    process.exit(2);
  }

  let others = 0;
  try { others = db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE id <> 1').get().n; }
  catch (e) { others = 0; /* no tenants table on this database: Roots is the only account */ }

  const rows = uniqueByTrade(db.prepare(CANDIDATES_SQL).all());
  db.close();
  console.log(`\n${rows.length} cancelled order(s) had a WeChat charge raised and no refund recorded. Asking WeChat about each…\n`);

  const out = { kept: [], refunded: [], not_paid: [], error: [] };
  for (const r of rows) {
    const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(r.out_trade_no)}?mchid=${encodeURIComponent(pay.mchId)}`;
    try {
      const resp = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: gw.signMerchantRequest('GET', urlPath, '', pay), 'User-Agent': gw.WX_PAY_USER_AGENT },
      });
      const j = resp.status === 404 ? {} : await resp.json();
      if (resp.status >= 400 && resp.status !== 404) throw new Error(`HTTP ${resp.status} ${j.code || ''} ${j.message || ''}`.trim());
      const state = j.trade_state || 'NOT_FOUND';
      const paid = j.amount && Number.isFinite(Number(j.amount.payer_total)) ? Number(j.amount.payer_total) / 100
        : (j.amount && Number.isFinite(Number(j.amount.total)) ? Number(j.amount.total) / 100 : null);
      out[classify(state)].push({ ...r, state, paid, success_time: j.success_time || null });
    } catch (e) {
      out.error.push({ ...r, error: e.message });
    }
    await new Promise((res) => setTimeout(res, PAUSE_MS));
  }

  const line = (x) => `  ${x.order_no}  placed ${bj(x.placed_at)}  cancelled ${bj(x.cancelled_at)} (${x.cancelled_reason || '—'})`
    + `  our row: ${x.payment_status} ${money(x.amount)}`
    + (x.paid != null ? `  WeChat took: ${money(x.paid)}` : '')
    + (x.success_time ? `  paid at ${x.success_time}` : '');

  console.log(`══ PAID AND KEPT — refund these (${out.kept.length}) ══`);
  out.kept.forEach((x) => console.log(line(x)));
  const keptTotal = out.kept.reduce((s, x) => s + (x.paid != null ? x.paid : Number(x.amount) || 0), 0);
  if (out.kept.length) console.log(`  total held: ${money(keptTotal)}`);

  console.log(`\n══ ALREADY REFUNDED on WeChat's side (${out.refunded.length}) ══`);
  out.refunded.forEach((x) => console.log(line(x)));

  console.log(`\n══ NEVER PAID — nothing held (${out.not_paid.length}) ══`);
  const byState = {};
  out.not_paid.forEach((x) => { byState[x.state] = (byState[x.state] || 0) + 1; });
  Object.entries(byState).forEach(([s, n]) => console.log(`  ${s}: ${n}`));

  if (out.error.length) {
    console.log(`\n══ COULD NOT ASK WeChat (${out.error.length}) — check these by hand ══`);
    out.error.forEach((x) => console.log(`  ${x.order_no} (${x.out_trade_no}): ${x.error}`));
  }
  console.log(`\nOther accounts not checked by this run: ${others}.`);
  console.log('Nothing was written and nothing was refunded.');
  process.exit(out.error.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { CANDIDATES_SQL, classify, uniqueByTrade, bj };
