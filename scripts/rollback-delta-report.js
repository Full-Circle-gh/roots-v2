#!/usr/bin/env node
/**
 * rollback-delta-report.js — what the window left on Postgres. G22.
 *
 *   node scripts/rollback-delta-report.js --since-db data/roots.db.pre-cutover
 *
 * ── THIS IS A REPORT. IT IS NOT A MERGE TOOL AND MUST NEVER BECOME ONE. ──
 * rollback-to-sqlite.sh restores the pre-flip database and carries nothing
 * back. Postgres is left untouched, so everything the window wrote is still
 * there, readable, with no time pressure on anybody. This lists it: by table,
 * with the orders and the money rows named by id, so a person can work through
 * them afterwards and decide what to re-enter.
 *
 * IT CANNOT WRITE, AND THAT IS ENFORCED BY THE SERVER RATHER THAN PROMISED BY
 * THIS FILE. Every statement runs inside `BEGIN TRANSACTION READ ONLY`, which
 * Postgres refuses to let any INSERT, UPDATE, DELETE or DDL out of, and the
 * transaction is ROLLBACKed at the end regardless. A guard that depends on this
 * file not containing the word UPDATE is a guard that lasts until somebody adds
 * one; this one holds even then.
 *
 * ── HOW THE DELTA IS DEFINED, AND WHAT IT CANNOT SEE ────────────────────
 * The watermark is MAX(id) per table in the PRE-FLIP SQLITE FILE. A Postgres row
 * whose id is above that watermark did not exist before the flip.
 *
 * THAT FINDS INSERTS. IT DOES NOT FIND UPDATES, AND IT CANNOT.
 * Only 40 of 129 non-empty tables carry updated_at. retail_customers is not one
 * of them, and it holds balance, points_balance, lifetime_spend and tier — so a
 * balance debited during the window is invisible to this report. Nine tables
 * have neither an id nor a created_at and get no row-level answer at all. And
 * deletes leave no trace anywhere.
 *
 * This is the same limitation that makes a reverse copy impossible (§24), so the
 * report states it rather than papering over it: the INSERT list is complete,
 * everything else is a prompt to go and look.
 */
'use strict';

// Tables worth naming row by row rather than counting. Everything with money or
// a customer obligation behind it.
const DETAIL = [
  { table: 'retail_orders', cols: ['id', 'order_no', 'status', 'total', 'customer_id', 'created_at'] },
  { table: 'retail_payments', cols: ['id', 'order_id', 'amount', 'status', 'created_at'] },
  { table: 'retail_topup_transactions', cols: ['id', 'customer_id', 'amount', 'payment_method', 'status', 'out_trade_no'] },
  { table: 'retail_points_transactions', cols: ['id', 'customer_id', 'delta', 'source', 'order_id'] },
  { table: 'retail_order_items', cols: ['id', 'order_id', 'product_id', 'qty'] },
  { table: 'retail_customers', cols: ['id', 'nickname', 'phone', 'created_at'] },
];

// Counted, not listed — high-volume and, in the quotes' case, explicitly
// disposable: retail_checkout_quotes is an abandonment log written best-effort
// inside a try/catch. It and the three sync logs are 63% of the database and
// almost all of the drift, which is the whole reason the rollback window is
// measured in days rather than minutes.
const COUNT_ONLY = [
  'retail_checkout_quotes', 'guanyi_sync_log', 'qingyun_sync_log', 'meituan_sync_log',
  'activity_log', 'retail_visits', 'retail_stock_ledger', 'retail_shipments',
  'retail_notifications', 'retail_auth_tokens', 'retail_order_addons', 'retail_refund_events',
];

const DISPOSABLE = new Set([
  'retail_checkout_quotes', 'guanyi_sync_log', 'qingyun_sync_log', 'meituan_sync_log',
]);

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`[delta-report] unsafe identifier: ${s}`);
  return `"${s}"`;
};

/**
 * Build the report.
 *
 * @param {(sql: string, params?: any[]) => Promise<{rows: any[]}>} query
 * @param {Record<string, number>} watermarks  table -> MAX(id) before the flip
 */
async function buildReport(query, watermarks) {
  const out = { detail: [], counts: [], missing: [], totals: { rows: 0, business: 0, disposable: 0 } };

  // Server-enforced read-only. Everything below runs inside this.
  await query('BEGIN TRANSACTION READ ONLY');
  try {
    for (const spec of DETAIL) {
      const wm = watermarks[spec.table];
      if (wm === undefined) { out.missing.push(spec.table); continue; }
      const cols = spec.cols.map(ident).join(', ');
      const r = await query(
        `SELECT ${cols} FROM ${ident(spec.table)} WHERE id > $1 ORDER BY id`, [wm]
      );
      const rows = (r && r.rows) || [];
      out.detail.push({ table: spec.table, watermark: wm, rows });
      out.totals.rows += rows.length;
      out.totals.business += rows.length;
    }
    for (const table of COUNT_ONLY) {
      const wm = watermarks[table];
      if (wm === undefined) { out.missing.push(table); continue; }
      const r = await query(`SELECT COUNT(*)::int AS n FROM ${ident(table)} WHERE id > $1`, [wm]);
      const n = (r && r.rows && r.rows[0] && r.rows[0].n) || 0;
      out.counts.push({ table, watermark: wm, rows: n, disposable: DISPOSABLE.has(table) });
      out.totals.rows += n;
      if (DISPOSABLE.has(table)) out.totals.disposable += n; else out.totals.business += n;
    }
  } finally {
    // Rolled back on every path, including a throw. Nothing this ran could have
    // written anything, and the transaction does not outlive the report either.
    await query('ROLLBACK');
  }
  return out;
}

function render(rep) {
  const L = [];
  L.push('WHAT THE WINDOW LEFT ON POSTGRES');
  L.push('');
  L.push('Postgres was NOT modified by the rollback and was NOT modified by this report.');
  L.push('Every row below still exists there. Nothing here is urgent.');
  L.push('');
  for (const d of rep.detail) {
    L.push(`── ${d.table} — ${d.rows.length} new row(s) since id ${d.watermark}`);
    for (const r of d.rows) {
      L.push('   ' + Object.entries(r).map(([k, v]) => `${k}=${v === null ? 'NULL' : v}`).join('  '));
    }
    if (!d.rows.length) L.push('   (none)');
    L.push('');
  }
  L.push('── counted only');
  for (const c of rep.counts) {
    L.push(`   ${c.table.padEnd(30)} ${String(c.rows).padStart(7)}${c.disposable ? '   (disposable)' : ''}`);
  }
  if (rep.missing.length) {
    L.push('');
    L.push('── NO WATERMARK, NOT REPORTED: ' + rep.missing.join(', '));
  }
  L.push('');
  L.push(`TOTAL ${rep.totals.rows} row(s): ${rep.totals.business} to look at, ${rep.totals.disposable} disposable.`);
  L.push('');
  L.push('WHAT THIS DOES NOT SHOW, AND YOU MUST GO AND LOOK:');
  L.push('  * UPDATES. 89 of 129 tables carry no updated_at, retail_customers among them —');
  L.push('    a balance debited or a tier promoted during the window is not listed here.');
  L.push('  * DELETES. Nothing tombstones; a row removed during the window leaves no trace.');
  L.push('  * The nine tables with neither an id nor a created_at (storefront_config,');
  L.push('    channel_status, qingyun_status and six others) have no row-level answer at all.');
  return L.join('\n');
}

module.exports = { buildReport, render, DETAIL, COUNT_ONLY, DISPOSABLE };

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
    const sqlitePath = at('--since-db') || require('path').join(__dirname, '..', 'data', 'roots.db.pre-cutover');

    const Database = require('better-sqlite3');
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    const watermarks = {};
    for (const t of [...DETAIL.map((d) => d.table), ...COUNT_ONLY]) {
      try {
        watermarks[t] = db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM ${ident(t)}`).get().n;
      } catch { /* table absent on the SQLite side — reported as missing */ }
    }
    db.close();

    const { pool } = require('../lib/pg');
    const client = await pool.connect();
    try {
      const rep = await buildReport((sql, params) => client.query(sql, params), watermarks);
      console.log(render(rep));
    } finally {
      client.release();
      await pool.end();
    }
  })().catch((e) => { console.error('[delta-report]', e.message); process.exit(1); });
}
