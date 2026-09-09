#!/usr/bin/env node
/**
 * diagnose_tenant_timezones.js — THE GATE for §82's startup check.
 *
 * §82 rules that time is a tenant property and that "a tenant with no timezone
 * set is a configuration error and must fail loudly at startup, not default".
 *
 * That check cannot be written blind. A boot-time throw added before every live
 * account carries a zone does not surface a configuration error — it stops
 * production starting. So this reads what is actually on file first.
 *
 * The zone resolves the way lib/business-date.js's shopTimezone() resolves it,
 * and the ORDER matters, so both inputs are reported separately rather than
 * collapsed into one answer:
 *
 *   1. the first active location carrying a non-blank retail_stores.timezone
 *   2. failing that, storefront_config['shop.timezone'] (seeded at sign-up)
 *   3. failing both, NULL — which today means the house default, Asia/Shanghai,
 *      and under §82 would mean a refusal to boot
 *
 * Every statement is a SELECT. The database is opened read-only and the
 * connection is PROVEN read-only before anything else runs, by attempting a
 * CREATE TABLE and aborting if the write is accepted.
 *
 *   node scripts/diagnose_tenant_timezones.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';

function loadSqlite() {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require('/root/roots-v2/node_modules/better-sqlite3'); }
}
const Database = loadSqlite();

function openRo(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; }
  if (!proven) {
    console.error(`FATAL: ${file} accepted a write. Aborting without reading anything.`);
    process.exit(2);
  }
  return db;
}

const main = openRo(DB_PATH);
console.log('read-only PROVEN — writes rejected on every connection opened below');
console.log('db:           ' + DB_PATH);
console.log('run at (UTC): ' + new Date().toISOString());
console.log('');

// The two inputs shopTimezone() reads, reported separately and in its order.
function zonesFor(db, label) {
  const out = { label, locations: [], shopConfig: null, resolved: null, via: null };
  try {
    out.locations = db.prepare(
      `SELECT id, code, name_en, is_active, sort_order, timezone
         FROM retail_stores ORDER BY sort_order, id`
    ).all();
  } catch (e) { out.locationsError = e.message; }
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'shop.timezone'").get();
    out.shopConfig = row ? JSON.parse(row.value_json) : null;
  } catch (e) { out.shopConfigError = e.message; }

  const live = out.locations.find(s => Number(s.is_active) === 1
    && s.timezone != null && String(s.timezone).trim() !== '');
  if (live) { out.resolved = String(live.timezone).trim(); out.via = `retail_stores#${live.id} (${live.code})`; }
  else if (typeof out.shopConfig === 'string' && out.shopConfig.trim()) {
    out.resolved = out.shopConfig.trim(); out.via = "storefront_config['shop.timezone']";
  } else { out.via = 'NOTHING — falls back to the house default today'; }
  return out;
}

function report(z) {
  console.log(`── ${z.label}`);
  if (z.locationsError) console.log('   retail_stores unreadable: ' + z.locationsError);
  for (const s of z.locations) {
    console.log('   ' + JSON.stringify({
      id: s.id, code: s.code, name: s.name_en, active: s.is_active, timezone: s.timezone,
    }));
  }
  if (!z.locations.length) console.log('   (no locations)');
  console.log(`   shop.timezone: ${z.shopConfig === null ? '(unset)' : JSON.stringify(z.shopConfig)}`
    + (z.shopConfigError ? ` [${z.shopConfigError}]` : ''));
  console.log(`   → RESOLVES TO: ${z.resolved === null ? 'NULL' : z.resolved}   via ${z.via}`);
  console.log('');
  return z;
}

const results = [];
try {
  const tenants = main.prepare('SELECT id, name, status FROM tenants ORDER BY id').all();
  console.log(`tenants table: ${tenants.length} row(s)\n`);
  for (const t of tenants) {
    results.push(report(zonesFor(main, `tenant ${t.id} — ${t.name} (${t.status}) — roots.db`)));
  }
} catch (e) {
  console.log('tenants table unreadable (' + e.message + ') — reporting roots.db alone\n');
  results.push(report(zonesFor(main, 'roots.db')));
}

// Other tenant databases, if any. Reported so the answer says what it measured.
const tdir = path.join(path.dirname(DB_PATH), 'tenants');
try {
  for (const f of fs.readdirSync(tdir).filter(x => x.endsWith('.db'))) {
    const full = path.join(tdir, f);
    if (path.resolve(full) === path.resolve(DB_PATH)) continue;
    try { results.push(report(zonesFor(openRo(full), `data/tenants/${f}`))); }
    catch (e) { console.log(`── data/tenants/${f}\n   unreadable: ${e.message}\n`); }
  }
} catch (e) { console.log('data/tenants/: not present (' + e.message + ')\n'); }

const missing = results.filter(r => r.resolved === null);
console.log('════ VERDICT ════');
console.log(`${results.length} database(s) read · ${missing.length} with NO zone on file`);
if (missing.length) {
  for (const m of missing) console.log('   MISSING: ' + m.label);
  console.log('\n  → §82\'s startup check would REFUSE TO BOOT for these. Set a zone');
  console.log('    on each (a location\'s timezone, or shop.timezone) BEFORE adding it.');
} else {
  console.log('  → every database read carries a zone. §82\'s startup check can be');
  console.log('    added without stopping production from starting.');
}
console.log('\ndone — nothing was written.');
