#!/usr/bin/env node
/**
 * diagnose_eleme_listing_owners.js — who else claims the listings a loose name
 * match would write to, and what the affected products' real stock is.
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_eleme_listing_owners.js
 *
 * READ-ONLY, AND IT PROVES IT. Opens SQLite with `readonly: true,
 * fileMustExist: true` and requires a probe write to be REJECTED before reading
 * anything; a connection that accepts the write aborts with exit 2. No UPDATE,
 * DELETE, INSERT, ALTER or CREATE except that probe. Enqueues nothing, pushes
 * nothing, touches no process.
 *
 * WHY THIS EXISTS
 * ---------------
 * diagnose_eleme_loose_match.js established that eleme_product_map id 375
 * ("芒", product 80) resolves through the loose branch at
 * lib/eleme-browser.js:807-812 to the listing "芒果蛋白球 Mango Bites", and that
 * a push of 25 was accepted against it on 2026-08-25. It did NOT establish
 * whether that listing belongs to a different product — which is the difference
 * between writing a number onto an unclaimed listing and silently overwriting
 * another product's stock.
 *
 * It also corrects a defect in that script: it read physical_qty from
 * store_products, where the column does not exist. Physical stock lives in
 * retail_store_stock (database.js:2782), which is what lib/bundle-stock.js:62
 * reads. This one reads it from there.
 */
'use strict';

const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');

const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3')); }
})();

// The listings the loose branch resolves to, from the previous run's output.
const LISTINGS = [
  '芒果蛋白球 Mango Bites',
  '芒果康普茶 Mango Kombucha',
  '凯特芒果干 Dehydrated Keitt Mango',
  '香柠草康普茶 Lemongrass Kombucha',
];
const PRODUCTS = [80, 358];

const J = v => (v === null || v === undefined ? 'NULL' : String(v));
function section(t) { console.log('\n' + '═'.repeat(78) + '\n══ ' + t + '\n'); }
function shanghai(s) {
  if (s == null) return '—';
  const t = Date.parse(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? new Date(t + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' +08' : '—';
}

console.log('diagnose_eleme_listing_owners.js — who owns the listings a loose match hits');
console.log('run at (+08): ' + new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
console.log('db:           ' + DB_PATH);

let db;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch (e) { console.error('FATAL: cannot open ' + DB_PATH + ': ' + e.message); process.exit(2); }
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('\nread-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: connection accepted a write. Aborting.'); process.exit(2); }

const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { console.log('   query failed: ' + e.message); return []; } };
const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (e) { console.log('   query failed: ' + e.message); return null; } };
const guard = (t, fn) => { try { fn(); } catch (e) { console.log('   SECTION FAILED (' + t + '): ' + e.message); } };

guard('owners', () => {
  section('1 · WHO CLAIMS EACH LISTING THE LOOSE BRANCH WOULD HIT');
  for (const name of LISTINGS) {
    console.log('\n   ── listing "' + name + '"');
    const c = one('SELECT * FROM eleme_catalogue_cache WHERE store_code = ? AND name = ?', 'tianhe', name);
    if (!c) { console.log('      not in the catalogue cache'); continue; }
    console.log(`      cache id=${c.id}  item_global_id=${J(c.item_global_id)}  listing stock=${J(c.stock)}  read ${shanghai(c.updated_at)}`);
    let specs = []; try { specs = JSON.parse(c.specs || '[]'); } catch (e) {}
    if (Array.isArray(specs)) specs.forEach((s, i) =>
      console.log(`        box[${i + 1}] "${J(s.name)}" specGlobalId=${J(s.specGlobalId)} price=${J(s.price)} stock=${J(s.stock)}`));

    const owners = all(
      `SELECT m.id, m.product_id, m.eleme_name, m.spec_id, m.spec_key, m.sync_enabled,
              m.last_pushed_qty, m.last_pushed_at, m.units_per_pack,
              p.sku, p.name_cn, p.name_en,
              (SELECT physical_qty FROM retail_store_stock s
                WHERE s.store_id = m.retail_store_id AND s.product_id = m.product_id) AS physical_qty
         FROM eleme_product_map m
         LEFT JOIN store_products p ON p.id = m.product_id
        WHERE m.store_code = ? AND m.eleme_name = ?
        ORDER BY m.id`, 'tianhe', name);
    console.log('      mappings naming this listing EXACTLY: ' + owners.length);
    for (const o of owners) {
      console.log(`        map id=${o.id} product ${o.product_id} sku=${J(o.sku)} enabled=${o.sync_enabled}`);
      console.log(`            product      ${J(o.name_cn)} / ${J(o.name_en)}`);
      console.log(`            spec_id=${J(o.spec_id)} spec_key="${J(o.spec_key)}" units_per_pack=${J(o.units_per_pack)}`);
      console.log(`            physical_qty ${J(o.physical_qty)}   last_pushed ${J(o.last_pushed_qty)} at ${o.last_pushed_at ? shanghai(o.last_pushed_at) : 'never'}`);
      if (o.physical_qty != null && c.stock != null) {
        console.log(`            listing shows ${c.stock}, owner holds ${o.physical_qty} → ` +
          (Number(c.stock) === Number(o.physical_qty) ? 'AGREE' : 'DISAGREE'));
      }
    }
  }
});

guard('products', () => {
  section('2 · THE PRODUCTS BEHIND THE LOOSE MAPPINGS — real stock');
  for (const pid of PRODUCTS) {
    const p = one('SELECT id, sku, name_cn, name_en, is_active FROM store_products WHERE id = ?', pid);
    if (!p) { console.log('   product ' + pid + ': not found'); continue; }
    const st = all('SELECT store_id, physical_qty FROM retail_store_stock WHERE product_id = ?', pid);
    console.log(`\n   product ${p.id}  sku=${J(p.sku)}  ${J(p.name_cn)} / ${J(p.name_en)}  active=${p.is_active}`);
    for (const s of st) console.log(`      retail_store_stock store_id=${s.store_id}  physical_qty=${J(s.physical_qty)}`);
    const maps = all('SELECT id, store_code, eleme_name, spec_key, sync_enabled, last_pushed_qty FROM eleme_product_map WHERE product_id = ? ORDER BY id', pid);
    console.log(`      eleme_product_map rows for this product: ${maps.length}`);
    for (const m of maps) console.log(`        id=${m.id} store=${m.store_code} enabled=${m.sync_enabled} spec_key="${J(m.spec_key)}" name="${J(m.eleme_name)}" last_pushed=${J(m.last_pushed_qty)}`);
    // Other channels, for contrast.
    for (const t of ['meituan_product_map', 'guanyi_product_map']) {
      const rows = all(`SELECT id, sync_enabled FROM ${t} WHERE product_id = ?`, pid);
      if (rows.length) console.log(`      ${t}: ${rows.length} row(s), enabled=${rows.map(r => r.sync_enabled).join(',')}`);
    }
  }
});

guard('queue-history', () => {
  section('3 · WAS 375 EVER ENABLED? — every queue row ever written for product 80');
  console.log('   eleme_sync_queue rows can only be inserted by lib/eleme-sync.js:55 and :76,');
  console.log('   both of which require sync_enabled = 1. Each row is therefore evidence that');
  console.log('   the mapping was enabled at that row\'s created_at.\n');
  const rows = all('SELECT id, new_qty, status, attempts, created_at, processed_at FROM eleme_sync_queue WHERE product_id = 80 ORDER BY id');
  for (const r of rows) console.log(`     id=${r.id} qty=${r.new_qty} ${r.status} attempts=${r.attempts} created ${shanghai(r.created_at)}`);
  const m = one('SELECT created_at, updated_at, sync_enabled FROM eleme_product_map WHERE id = 375');
  if (m) {
    console.log(`\n     map 375 created ${shanghai(m.created_at)}  updated ${shanghai(m.updated_at)}  sync_enabled now ${m.sync_enabled}`);
    console.log('     routes/eleme-admin.js:316-320 is the ONLY path that writes sync_enabled,');
    console.log('     and it always sets updated_at in the same statement. An updated_at that');
    console.log('     predates the last queue row therefore cannot be reconciled with the flag');
    console.log('     having been turned off through the admin UI.');
  }
});

section('DONE');
console.log('Nothing was written. Nothing was enqueued. No process was touched.');
db.close();
