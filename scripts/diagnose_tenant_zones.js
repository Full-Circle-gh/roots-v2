#!/usr/bin/env node
/**
 * diagnose_tenant_zones.js — who are the tenants with no timezone, and are any
 * of them trading?
 *
 * §82 asks that a tenant with no timezone fail loudly at startup. On
 * production none of them has one (diagnose_server_clock.js): Roots' two stores
 * carry no zone, and tenants 2, 4, 5, 6 and 7 have no stores and no
 * `shop.timezone`. Before any of them is given a zone, or refused for lacking
 * one, this says what each one is:
 *
 *   1. the platform's tenants row — name, status and dates only (the column
 *      list is printed, but secrets, keys and images are never read);
 *   2. per tenant database: the sign-up answers (country, currency, language,
 *      timezone), whether a store exists, and whether it has ever traded —
 *      counts and dates of products, customers and orders.
 *
 * Every statement is a SELECT. Each database is opened read-only and the
 * connection is PROVEN read-only before anything is read from it. Counts and
 * dates only: no customer, order or staff detail is printed.
 *
 *   node scripts/diagnose_tenant_zones.js   (via .github/workflows/ro-query.yml)
 */
'use strict';

const path = require('path');
const fs = require('fs');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const TENANTS_DIR = path.join(path.dirname(DB_PATH), 'tenants');

function loadSqlite() {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('/root/roots-v2/node_modules/better-sqlite3'); }
}
const Database = loadSqlite();

function openReadOnly(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (e) { proven = true; }
  if (!proven) {
    console.error('FATAL: ' + file + ' accepted a write. Aborting without reading anything.');
    process.exit(2);
  }
  return db;
}
const J = (v) => JSON.stringify(v);
const one = (db, sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (e) { return { err: e.message.split('\n')[0] }; } };

// Only these tenants columns are ever read. Anything else (app secrets, keys,
// logos) is listed by NAME so the shape is visible, and never selected.
const SAFE = /^(id|name|brand_name|slug|code|status|plan|kind|type|is_internal|internal|country|created_at|updated_at|activated_at|suspended_at|trial_ends_at|rbac_enforce)$/;

const main = openReadOnly(DB_PATH);
console.log('run at (UTC): ' + new Date().toISOString() + '\n');

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 1 · the platform\'s tenants table ══');
let tenantRows = [];
try {
  const cols = main.prepare('PRAGMA table_info(tenants)').all().map((c) => c.name);
  const safe = cols.filter((c) => SAFE.test(c));
  console.log('columns: ' + cols.join(', '));
  console.log('reading: ' + safe.join(', ') + '\n');
  tenantRows = main.prepare('SELECT ' + safe.join(', ') + ' FROM tenants ORDER BY id').all();
  for (const t of tenantRows) console.log('  ' + J(t));
} catch (e) { console.log('tenants unreadable: ' + e.message); }

for (const [label, table] of [['operators (tenant_users)', 'tenant_users'], ['custom domains', 'tenant_domains']]) {
  try {
    const rows = main.prepare(`SELECT tenant_id, COUNT(*) AS n FROM ${table} GROUP BY tenant_id ORDER BY tenant_id`).all();
    console.log('\n' + label + ' per tenant: ' + (rows.length ? rows.map((r) => r.tenant_id + ':' + r.n).join('  ') : '(none)'));
  } catch (e) { console.log('\n' + label + ': ' + e.message.split('\n')[0]); }
}
try {
  const rows = main.prepare(`SELECT tenant_id, MAX(last_login_at) AS last FROM tenant_users GROUP BY tenant_id ORDER BY tenant_id`).all();
  console.log('last operator login per tenant: ' + rows.map((r) => r.tenant_id + ':' + (r.last || '-')).join('  '));
} catch (e) { /* no such column on this schema */ }

// ════════════════════════════════════════════════════════════════════════════
function tenantReport(label, file) {
  console.log('\n══ ' + label + ' — ' + path.basename(file) + ' ══');
  let db;
  try { db = openReadOnly(file); } catch (e) { console.log('  unopenable: ' + e.message); return; }
  const cfg = {};
  for (const k of ['shop.timezone', 'shop.country', 'currency', 'theme.language', 'shop.name', 'brand.name']) {
    const r = one(db, 'SELECT value_json FROM storefront_config WHERE key = ?', k);
    cfg[k] = r && r.value_json !== undefined ? r.value_json : (r && r.err ? 'err' : '(not set)');
  }
  console.log('  sign-up answers: ' + J(cfg));
  const n = one(db, 'SELECT COUNT(*) AS n FROM storefront_config');
  console.log('  config keys in all: ' + (n && n.n !== undefined ? n.n : n.err));
  const st = one(db, `SELECT COUNT(*) AS n, SUM(is_active = 1) AS active,
                             SUM(timezone IS NOT NULL AND TRIM(timezone) <> '') AS zoned FROM retail_stores`);
  console.log('  stores: ' + J(st));
  // Each store's zone AS STORED, and whether this runtime can read it — §82 step
  // 3 full refuses an unreadable one, so a misspelling here would stop orders.
  let zr = [];
  try { zr = db.prepare('SELECT id, code, is_active, timezone FROM retail_stores ORDER BY id').all(); } catch (e) { zr = []; }
  for (const z of zr) {
    let ok = false;
    try { if (z.timezone && String(z.timezone).trim()) { new Intl.DateTimeFormat('en-US', { timeZone: String(z.timezone).trim() }); ok = true; } } catch (e) { ok = false; }
    console.log('    store #' + z.id + ' ' + z.code + ' active=' + z.is_active + ' timezone=' + J(z.timezone) + ' readable=' + ok);
  }
  const p = one(db, 'SELECT COUNT(*) AS n FROM store_products');
  console.log('  products: ' + J(p));
  const c = one(db, 'SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM retail_customers');
  console.log('  customers: ' + J(c));
  const o = one(db, `SELECT COUNT(*) AS n, MIN(placed_at) AS first, MAX(placed_at) AS last,
                            SUM(placed_at >= datetime('now', '-30 days')) AS last30,
                            SUM(status NOT IN ('cancelled', 'pending_payment')) AS real_orders
                       FROM retail_orders`);
  console.log('  orders: ' + J(o));
}

tenantReport('tenant 1 (Roots, the shared database)', DB_PATH);
let files = [];
try { files = fs.readdirSync(TENANTS_DIR).filter((f) => /^\d+\.db$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b)); }
catch (e) { console.log('\n' + TENANTS_DIR + ' unreadable: ' + e.message); }
for (const f of files) tenantReport('tenant ' + parseInt(f), path.join(TENANTS_DIR, f));

const ids = new Set(tenantRows.map((t) => t.id));
const withDb = new Set(files.map((f) => parseInt(f)).concat([1]));
const noDb = [...ids].filter((id) => !withDb.has(id));
const noRow = [...withDb].filter((id) => !ids.has(id));
const list = (a) => (a.length ? a.length + ' — ' + a.slice(0, 20).join(', ') + (a.length > 20 ? ', …' : '') : 'none');
console.log('\ntenants with a row but no database: ' + list(noDb));
console.log('databases with no tenants row:      ' + list(noRow));
console.log('\ndone — nothing was written.');
