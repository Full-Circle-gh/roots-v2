#!/usr/bin/env node
/**
 * diagnose_eleme_name_match.js — before renaming an Eleme mapping: prove which
 * cached listing it should point at, byte for byte, and how many stock boxes
 * that listing holds.
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_eleme_name_match.js
 *   Target: PRODUCT_ID env var, default 195. STORE_CODE env var, default tianhe.
 *
 * READ-ONLY, AND IT PROVES IT. Opened `readonly: true, fileMustExist: true`,
 * with a write attempted and REQUIRED to fail before a single row is read; a
 * connection that accepts the write aborts with exit 2. No UPDATE, DELETE,
 * INSERT, ALTER or CREATE except that one probe, which exists to be rejected.
 * It changes nothing, enqueues nothing and touches no process.
 *
 * WHY THIS EXISTS — THE SIZE TRAP
 * -------------------------------
 * Fixing a mapping's name is only half the job. lib/eleme-browser.js:860-889
 * decides which stock box gets the number in three steps: an operator-claimed
 * spec wins; failing that a SINGLE-option listing is unambiguous and takes it;
 * failing BOTH it falls through to a documented GUESS — `N >= 3` writes 9999 to
 * every box, otherwise the first box gets N and the rest get 0. So renaming a
 * product onto a multi-option listing without also claiming its option turns an
 * overselling bug into sizes reading sold-out that are not. The spec count has
 * to be known BEFORE the push, not after.
 *
 * THE NAME IS NEVER RETYPED, HERE OR IN THE FIX
 * ---------------------------------------------
 * A retyped string is what caused the fault being repaired (and, per
 * public/retail-admin/14-eleme.js:628-631, a curly apostrophe caused an earlier
 * one). So this does not search for a name literal. It finds the cached listing
 * whose name BECOMES the stored mapping name when the known typo is injected —
 * `replace(name, GOOD, BAD) = eleme_product_map.eleme_name`. If exactly one row
 * satisfies that, then the two strings are proven identical everywhere except
 * that one substring, including in any character a terminal will not show.
 * hex() of both is printed so the difference can be read as bytes rather than
 * as glyphs.
 *
 * GOOD/BAD are supplied as env vars rather than baked in, so the same script
 * serves the next mapping typo without an edit.
 *
 * STOCK IS RE-READ AT RUN TIME, and the read timestamp is printed beside it. A
 * figure carried over from an earlier report is exactly how a stale number gets
 * pushed; this item sells, so "yesterday's 3" is not evidence about tonight.
 *
 * EXIT CODES
 *   0  ran
 *   2  REFUSED: a connection accepted a write, or no database could be read.
 */
'use strict';

const path = require('path');

const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');
const PRODUCT_ID = Number(process.env.PRODUCT_ID || 195);
const STORE_CODE = process.env.STORE_CODE || 'tianhe';
// The correction, as a substring pair. GOOD is what the catalogue carries; BAD
// is what the mapping wrongly carries. Never a whole name.
const GOOD = process.env.GOOD_FRAGMENT || 'Hulled';
const BAD  = process.env.BAD_FRAGMENT  || 'HSulled';

const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3')); }
})();

const NOW = Date.now();
const J = v => (v === null || v === undefined ? 'NULL' : String(v));
function parseUtc(s) {
  if (s == null) return null;
  const t = Date.parse(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? t : null;
}
function shanghai(s) {
  const t = parseUtc(s);
  return t == null ? '—'
    : new Date(t + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' +08';
}
function ageOf(s) {
  const t = parseUtc(s);
  if (t == null) return 'unparseable';
  const m = Math.round((NOW - t) / 60_000);
  if (Math.abs(m) < 90) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ${h % 24}h ago`;
}
function section(t) { console.log('\n' + '═'.repeat(78) + '\n══ ' + t + '\n'); }
function dump(rows, ind = '   ') {
  if (!rows || !rows.length) { console.log(ind + '(no rows)'); return; }
  rows.forEach((r, i) => {
    console.log(`${ind}[${i + 1}]`);
    for (const k of Object.keys(r)) console.log(`${ind}    ${String(k).padEnd(22)} ${J(r[k])}`);
  });
}

console.log('diagnose_eleme_name_match.js — prove the listing, and count its stock boxes');
console.log('product_id:      ' + PRODUCT_ID);
console.log('store_code:      ' + STORE_CODE);
console.log('correction:      ' + JSON.stringify(BAD) + '  →  ' + JSON.stringify(GOOD) + '  (substring only)');
console.log('READ AT (UTC):   ' + new Date(NOW).toISOString());
console.log('READ AT (+08):   ' + new Date(NOW + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
console.log('db:              ' + DB_PATH);

let db;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch (e) { console.error('FATAL: cannot open ' + DB_PATH + ': ' + e.message); process.exit(2); }

let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('\nread-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write. Aborting.'); process.exit(2); }

const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { console.log('   QUERY FAILED: ' + e.message); return []; } };

// ════════════════════════════════════════════════════════════════════════════
section('(a) THE MAP ROW — what we would be changing');
const maps = all(
  `SELECT id, product_id, retail_store_id, store_code, spec_key, spec_id, spec_name,
          units_per_pack, sync_enabled, last_pushed_qty, last_pushed_at,
          eleme_name, hex(eleme_name) AS current_bytes, length(eleme_name) AS chars,
          created_at, updated_at
     FROM eleme_product_map
    WHERE product_id = ?
    ORDER BY id`, PRODUCT_ID);
console.log(`   eleme_product_map rows for product ${PRODUCT_ID}: ${maps.length}`);
dump(maps);
if (maps.length !== 1) {
  console.log('   !! EXPECTED EXACTLY 1. More than one mapping means more than one target —');
  console.log('      do not proceed on the assumption that renaming one row is the whole fix.');
}

// ════════════════════════════════════════════════════════════════════════════
section('(b) THE CACHE ROW — proven by injection, not by matching a typed name');
console.log(`   Rule: replace(cache.name, ${JSON.stringify(GOOD)}, ${JSON.stringify(BAD)}) = map.eleme_name`);
console.log('   Exactly one match proves the two differ ONLY in that substring.\n');

const cands = all(
  `SELECT c.id, c.store_code, c.name, hex(c.name) AS replacement_bytes,
          length(c.name) AS chars, c.item_global_id, c.stock, c.updated_at,
          json_array_length(c.specs) AS spec_count, c.specs
     FROM eleme_catalogue_cache c
    WHERE c.store_code = ?
      AND replace(c.name, ?, ?) = (SELECT m.eleme_name FROM eleme_product_map m
                                    WHERE m.product_id = ? ORDER BY m.id LIMIT 1)`,
  STORE_CODE, GOOD, BAD, PRODUCT_ID);

console.log(`   candidate cache rows: ${cands.length}`);
for (const c of cands) {
  console.log(`   [id ${c.id}]`);
  console.log(`       name                 ${J(c.name)}`);
  console.log(`       chars                ${J(c.chars)}`);
  console.log(`       replacement_bytes    ${J(c.replacement_bytes)}`);
  console.log(`       item_global_id       ${J(c.item_global_id)}`);
  console.log(`       stock                ${J(c.stock)}   ← what Eleme shows now`);
  console.log(`       updated_at           ${J(c.updated_at)} UTC → ${shanghai(c.updated_at)} (${ageOf(c.updated_at)})`);
  console.log(`       SPEC_COUNT           ${J(c.spec_count)}`);
  console.log(`       specs (raw)          ${J(c.specs)}`);
  let specs = null;
  try { specs = JSON.parse(c.specs); } catch (e) { /* not JSON */ }
  if (Array.isArray(specs)) {
    console.log('       ── every stock box on this listing ──');
    specs.forEach((s, i) => {
      console.log(`         box[${i + 1}] specGlobalId=${J(s && s.specGlobalId)} name=${J(s && s.name)} `
        + `price=${J(s && s.price)} stock=${J(s && s.stock)}`);
    });
  }
}

if (cands.length === 1) {
  const c = cands[0];
  const n = Number(c.spec_count);
  console.log('');
  if (n === 1) {
    console.log('   VERDICT: SPEC_COUNT = 1 — single box, unambiguous.');
    console.log('   lib/eleme-browser.js:876-878 takes the "exactly one size" branch. No option');
    console.log('   claim is needed; the name alone is enough and the GUESS path is not reached.');
  } else if (n > 1) {
    console.log(`   VERDICT: SPEC_COUNT = ${n} — MULTI-BOX. STOP.`);
    console.log('   With no claimed option, lib/eleme-browser.js:880-889 GUESSES: qty >= 3 writes');
    console.log('   9999 to EVERY box; otherwise box 1 gets qty and the rest get 0. The option');
    console.log('   must be claimed (admin size picker / POST /eleme/products/:id/claim) before');
    console.log('   any push, or this writes a wrong shape into a live listing.');
  } else {
    console.log('   VERDICT: spec_count is NULL/0 — specs not cached for this listing.');
    console.log('   Treat as UNKNOWN, not as one: a catalogue read has not populated it.');
  }
} else if (cands.length === 0) {
  console.log('\n   !! NO CANDIDATE. The stored name is not the cached name plus this typo.');
  console.log('      Do NOT rename on a guess. The near-miss list below is context only.');
} else {
  console.log('\n   !! MORE THAN ONE CANDIDATE — ambiguous. Stop and look at them by hand.');
}

// Context only, never a source for the fix: what else is in the cache that
// resembles the stored name. Printed so a zero-candidate result above can be
// understood rather than guessed at.
section('CONTEXT — cached listings resembling the stored name (NOT a source for the fix)');
const stored = maps.length ? String(maps[0].eleme_name || '') : '';
const cacheAll = all('SELECT id, name, stock, json_array_length(specs) AS spec_count, updated_at FROM eleme_catalogue_cache WHERE store_code = ?', STORE_CODE);
console.log(`   cache size for ${STORE_CODE}: ${cacheAll.length} listing(s)`);
const near = cacheAll.filter(r => {
  const a = String(r.name || '');
  for (let i = 0; i + 6 <= stored.length; i++) if (a.includes(stored.substr(i, 6))) return true;
  return false;
});
dump(near.map(r => ({ id: r.id, name: r.name, stock: r.stock, spec_count: r.spec_count, updated_at: r.updated_at })));

// ════════════════════════════════════════════════════════════════════════════
section('TONIGHT\'S STOCK — re-read now, not carried over');
const stock = all(
  `SELECT s.code AS store_code, s.name_en AS store_name, ss.store_id, ss.product_id,
          ss.physical_qty, ss.updated_at
     FROM retail_store_stock ss
     JOIN retail_stores s ON s.id = ss.store_id
    WHERE ss.product_id = ?
    ORDER BY s.sort_order, s.id`, PRODUCT_ID);
for (const r of stock) {
  console.log(`   ${String(r.store_code).padEnd(10)} store_id=${J(r.store_id)}  physical_qty=${J(r.physical_qty)}`
    + `   row last moved ${J(r.updated_at)} UTC → ${shanghai(r.updated_at)} (${ageOf(r.updated_at)})`);
}
console.log(`\n   Value read at ${new Date(NOW + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} +08.`);
console.log('   NOTE: the push does not use this column directly — lib/bundle-stock.js sellableAt()');
console.log('   resolves the figure at enqueue time (component floor for a bundle, this count');
console.log('   otherwise). Product 195 carries no bundle_items, so for it the two agree.');

const sp = all('SELECT id, sku, name_cn, name_en, is_active, stock_qty FROM store_products WHERE id = ?', PRODUCT_ID);
console.log('\n   store_products (for contrast — stock_qty is the vestigial legacy column):');
dump(sp);

// ════════════════════════════════════════════════════════════════════════════
section('QUEUE — current state, in case it moved since the last look');
dump(all(
  `SELECT id, retail_store_id, store_code, new_qty, status, attempts, last_error, created_at, processed_at
     FROM eleme_sync_queue WHERE product_id = ? ORDER BY id DESC LIMIT 12`, PRODUCT_ID));

const cache = all(
  'SELECT store_code, COUNT(*) AS entries, MAX(updated_at) AS last_refresh FROM eleme_catalogue_cache GROUP BY store_code');
console.log('\n   catalogue cache freshness:');
for (const c of cache) {
  console.log(`     ${String(c.store_code).padEnd(10)} entries=${J(c.entries)}  last refresh=${J(c.last_refresh)} UTC`
    + ` → ${shanghai(c.last_refresh)} (${ageOf(c.last_refresh)})`);
}

db.close();
section('DONE');
console.log('Nothing was written. Nothing was enqueued. No process was touched.');
