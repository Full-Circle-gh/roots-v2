#!/usr/bin/env node
/**
 * diagnose_server_clock.js — what clock does production run on, and which
 * stores name their own timezone?
 *
 * §82 (docs/tacet-consolidation-decisions.md) rules that the production host is
 * pinned to UTC, so code still reading host-local time is visibly wrong rather
 * than silently right for Roots. Nothing in the repository pins it, so before
 * anyone switches it this measures the two facts the switch depends on:
 *
 *   1. the server's clock — as a fresh shell sees it AND as the running app
 *      process sees it (pm2 may give the app its own TZ). Only the TZ variable
 *      is read from the app's environment; nothing else in it is printed.
 *   2. every store's timezone setting, and the tenant-wide shop.timezone, for
 *      the main database and each tenant database — the zone pickup and
 *      delivery fall back to when a store names none.
 *   3. how many recent orders came through stores with no timezone, so the
 *      report says what a host switch would have touched.
 *
 * Every statement is a SELECT. Each database is opened read-only and the
 * connection is PROVEN read-only before anything is read from it, by attempting
 * a CREATE TABLE and aborting if the write is accepted.
 *
 *   node scripts/diagnose_server_clock.js     (run via .github/workflows/ro-query.yml)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const cp = require('child_process');

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
const sh = (cmd) => { try { return cp.execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim(); } catch (e) { return '(unavailable: ' + String(e.message).split('\n')[0] + ')'; } };
const J = (v) => JSON.stringify(v);

// ════════════════════════════════════════════════════════════════════════════
console.log('══ 1 · the server clock ══');
{
  const now = new Date();
  console.log('run at (UTC):                 ' + now.toISOString());
  console.log('this shell  process.env.TZ:   ' + J(process.env.TZ || null));
  console.log('this shell  Intl zone:        ' + Intl.DateTimeFormat().resolvedOptions().timeZone);
  console.log('this shell  UTC offset (min): ' + (-now.getTimezoneOffset()));
  console.log('this shell  local wall clock: ' + now.toString());
  console.log('/etc/timezone:                ' + sh('cat /etc/timezone 2>/dev/null || echo "(none)"'));
  console.log('/etc/localtime ->             ' + sh('readlink -f /etc/localtime'));
  console.log('timedatectl zone:             ' + sh("timedatectl show -p Timezone --value 2>/dev/null || echo '(none)'"));

  // The running app: its node processes, and ONLY the TZ entry of each one's
  // environment. Secrets live in that environment; nothing else is printed.
  const ps = sh("ps -eo pid=,args= | grep -E 'node .*(server\\.js|daemon)' | grep -v grep || true");
  const procs = ps.split('\n').filter((l) => /\d/.test(l) && !/ro-query|diagnose_/.test(l));
  console.log('\nrunning node processes: ' + procs.length);
  for (const line of procs) {
    const pid = line.trim().split(/\s+/)[0];
    let tz = '(not set → follows the system zone above)';
    try {
      const env = fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0');
      const hit = env.find((e) => e.startsWith('TZ='));
      if (hit) tz = J(hit.slice(3));
    } catch (e) { tz = '(unreadable: ' + e.code + ')'; }
    const script = line.trim().split(/\s+/).slice(1).join(' ').replace(/\s+--.*$/, '').slice(0, 90);
    console.log('  pid ' + pid.padEnd(7) + ' TZ ' + tz.padEnd(44) + ' ' + script);
  }
}

// ════════════════════════════════════════════════════════════════════════════
function storesReport(label, file) {
  console.log('\n══ ' + label + ' — ' + file + ' ══');
  let db;
  try { db = openReadOnly(file); } catch (e) { console.log('  unopenable: ' + e.message); return; }
  try {
    const r = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'shop.timezone'").get();
    console.log('  shop.timezone (tenant-wide): ' + (r ? r.value_json : '(not set)'));
  } catch (e) { console.log('  shop.timezone unreadable: ' + e.message); }
  for (const k of ['pickup.window', 'pickup.leadMinutes']) {
    try {
      const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(k);
      console.log('  ' + k + ': ' + (r ? r.value_json : '(not set → code default)'));
    } catch (e) { /* older schema */ }
  }
  let stores = [];
  try {
    stores = db.prepare(`SELECT id, code, name_en, is_active, pickup_enabled, open_time, close_time, timezone
                           FROM retail_stores ORDER BY id`).all();
  } catch (e) { console.log('  retail_stores unreadable: ' + e.message); }
  console.log('  stores: ' + stores.length + ', with a timezone: ' + stores.filter((s) => s.timezone && String(s.timezone).trim()).length);
  for (const s of stores) {
    console.log('   #' + String(s.id).padEnd(5) + String(s.code || '').padEnd(14)
      + ' active=' + s.is_active + ' pickup=' + s.pickup_enabled
      + ' hours=' + (s.open_time || '–') + '–' + (s.close_time || '–')
      + ' timezone=' + J(s.timezone));
  }
  // What lib/business-date.js shopTimezone() answers: the first active store
  // that names a zone, else shop.timezone, else null (→ Asia/Shanghai).
  const first = stores.filter((s) => s.is_active === 1 && s.timezone && String(s.timezone).trim())[0];
  console.log('  tenant zone the code resolves: ' + (first ? J(first.timezone) + ' (from store #' + first.id + ')' : '(no store names one → shop.timezone, else Asia/Shanghai)'));

  // Exposure: recent orders whose store names no zone, by fulfilment type.
  try {
    const rows = db.prepare(`
      SELECT COALESCE(o.fulfillment_type, 'delivery') AS kind,
             CASE WHEN o.store_id IS NULL THEN 'no store'
                  WHEN s.id IS NULL THEN 'store row gone'
                  WHEN s.timezone IS NULL OR TRIM(s.timezone) = '' THEN 'store, no timezone'
                  ELSE 'store names a timezone' END AS zone_source,
             COUNT(*) AS n
        FROM retail_orders o LEFT JOIN retail_stores s ON s.id = o.store_id
       WHERE o.placed_at >= datetime('now', '-60 days')
       GROUP BY 1, 2 ORDER BY 1, 2`).all();
    console.log('  orders in the last 60 days, by where their zone would come from:');
    for (const r of rows) console.log('    ' + r.kind.padEnd(10) + r.zone_source.padEnd(26) + r.n);
    if (!rows.length) console.log('    (none)');
  } catch (e) { console.log('  orders unreadable: ' + e.message); }
  db.close();
}

storesReport('2 · main database (tenant 1, Roots)', DB_PATH);
let tenantFiles = [];
try { tenantFiles = fs.readdirSync(TENANTS_DIR).filter((f) => /^\d+\.db$/.test(f)).sort(); } catch (e) { /* none */ }
console.log('\n══ 3 · tenant databases in ' + TENANTS_DIR + ': ' + tenantFiles.length + ' ══');
for (const f of tenantFiles) storesReport('tenant ' + f.replace('.db', ''), path.join(TENANTS_DIR, f));

console.log('\ndone — nothing was written.');
