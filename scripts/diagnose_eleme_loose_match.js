#!/usr/bin/env node
/**
 * diagnose_eleme_loose_match.js — what a short or wrong mapping name actually
 * resolves to on Eleme, and what `last_pushed_qty` is really a record of.
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_eleme_loose_match.js
 *   Target:  MAP_ID env var (default 375), PRODUCT_ID env var (default 80).
 *
 * READ-ONLY, AND IT PROVES IT. Every database file is opened with
 * `readonly: true, fileMustExist: true` and a write is attempted and REQUIRED to
 * fail before a single row is read; a connection that accepts the write aborts
 * the run with exit 2. There is no UPDATE, DELETE, INSERT, ALTER or CREATE in
 * this file except that one probe, which exists to be rejected. It enqueues
 * nothing, pushes nothing, and starts, stops or restarts no process.
 *
 * WHY THIS EXISTS
 * ---------------
 * eleme_product_map row 375 (product 80, sku 4-200) is `sync_enabled = 0` and
 * its stored eleme_name is the single character 芒 — yet it carries
 * last_pushed_qty = 25 stamped 2026-08-25 11:21:07. Three explanations were on
 * the table: a push genuinely landed on something; last_pushed_qty is written
 * without a confirmed push; or the value is stale residue.
 *
 * THE MATCH RULE IS COPIED FROM THE PUSH PATH, NOT ASSUMED
 * -------------------------------------------------------
 * Section 4 does NOT test for an exact name match. It reimplements
 * lib/eleme-browser.js:807-812 `_findByFuzzyName` character for character:
 *
 *     for (const [k, v] of this._foodCache) {
 *       if (k === name || k.includes(name) || name.includes(k)) return v;
 *     }
 *
 * — an exact hit, OR the catalogue name containing the mapped name, OR the
 * mapped name containing the catalogue name. That third clause is why a
 * one-character mapping is not inert: 芒 is a substring of any listing whose
 * title contains it, so the loose branch returns a listing that has nothing to
 * do with product 80.
 *
 * ORDER MATTERS AND IS ONLY APPROXIMATED. `_findByFuzzyName` returns the FIRST
 * hit in _foodCache's Map insertion order, which is category order as Eleme
 * served it during that session. eleme_catalogue_cache is written from that
 * same iteration (lib/eleme-browser.js catalogueSnapshot → the daemon's cache
 * write), so ORDER BY id is a reasonable proxy — but it is a proxy, and this
 * script prints EVERY loose hit rather than only the first so the answer does
 * not depend on that assumption being right.
 *
 * Section 6 then asks the same question of every mapping on the store, because
 * a rule that turns 芒 into a wrong listing turns `bre`, `brea` and `gra` into
 * wrong listings too, and those were previously filed as harmlessly disabled.
 *
 * EXIT CODES
 *   0  ran
 *   2  REFUSED: a connection accepted a write, or no database could be read.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');
const MAP_ID = Number(process.env.MAP_ID || 375);
const PRODUCT_ID = Number(process.env.PRODUCT_ID || 80);

const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3')); }
})();

const NOW = Date.now();

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS', no zone marker, and IS UTC.
function parseUtc(stamp) {
  if (stamp == null) return null;
  const t = Date.parse(String(stamp).replace(' ', 'T') + (String(stamp).includes('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? t : null;
}
function shanghai(stamp) {
  const t = parseUtc(stamp);
  if (t == null) return '—';
  return new Date(t + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' +08';
}
function ageOf(stamp) {
  const t = parseUtc(stamp);
  if (t == null) return 'unparseable';
  const m = Math.round((NOW - t) / 60_000);
  if (Math.abs(m) < 90) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

const J = v => (v === null || v === undefined ? 'NULL' : String(v));
function section(t) { console.log('\n' + '═'.repeat(78) + '\n══ ' + t + '\n'); }
function kv(k, v, indent = '   ') { console.log(indent + String(k).padEnd(22) + ' ' + J(v)); }

// Byte-level rendering, so a "same-looking" string cannot hide a difference.
function bytesOf(s) {
  const b = Buffer.from(String(s), 'utf8');
  return `${b.length} bytes  hex=${b.toString('hex')}`;
}

console.log('diagnose_eleme_loose_match.js — what a short mapping name resolves to');
console.log('target MAP_ID:     ' + MAP_ID);
console.log('target PRODUCT_ID: ' + PRODUCT_ID);
console.log('run at (UTC):      ' + new Date(NOW).toISOString());
console.log('run at (+08):      ' + new Date(NOW + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
console.log('db:                ' + DB_PATH);

let db;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch (e) { console.error('FATAL: cannot open ' + DB_PATH + ': ' + e.message); process.exit(2); }

let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
catch (e) { proven = true; console.log('\nread-only PROVEN — write rejected: ' + e.message); }
if (!proven) { console.error('FATAL: the connection accepted a write. Aborting.'); process.exit(2); }

const tableNames = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name)
);
const has = t => tableNames.has(t);
const colsOf = t => { try { return db.pragma(`table_info(${t})`).map(c => c.name); } catch (e) { return []; } };
const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { console.log('   query failed: ' + e.message); return []; } };
const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (e) { console.log('   query failed: ' + e.message); return null; } };
const guard = (title, fn) => { try { fn(); } catch (e) { console.log('   SECTION FAILED (' + title + '): ' + e.message); } };

// ════════════════════════════════════════════════════════════════════════════
// 1 · the mapping row itself
// ════════════════════════════════════════════════════════════════════════════
let mapRow = null;
guard('mapping', () => {
  section(`1 · THE MAPPING — eleme_product_map id ${MAP_ID}`);
  if (!has('eleme_product_map')) { console.log('   no eleme_product_map table'); return; }
  mapRow = one('SELECT * FROM eleme_product_map WHERE id = ?', MAP_ID);
  if (!mapRow) { console.log('   no row with that id'); return; }
  for (const k of Object.keys(mapRow)) kv(k, mapRow[k]);
  console.log('');
  kv('eleme_name bytes', bytesOf(mapRow.eleme_name == null ? '' : mapRow.eleme_name));
  kv('name length (chars)', String(mapRow.eleme_name || '').length);
  console.log('');
  kv('created_at  (+08)', shanghai(mapRow.created_at) + '   ' + ageOf(mapRow.created_at));
  if ('updated_at' in mapRow) kv('updated_at  (+08)', shanghai(mapRow.updated_at) + '   ' + ageOf(mapRow.updated_at));
  kv('last_pushed_at (+08)', shanghai(mapRow.last_pushed_at) + '   ' + ageOf(mapRow.last_pushed_at));
  console.log('');
  console.log('   updated_at is written by the admin map routes (routes/eleme-admin.js:318,');
  console.log('   :331, :412, :417) and NOT by the daemon\'s last_pushed_qty write');
  console.log('   (scripts/eleme-daemon.js:555-558 sets last_pushed_qty + last_pushed_at only).');
  console.log('   So updated_at dates the last ADMIN EDIT of this row — any field, not');
  console.log('   sync_enabled specifically. There is no per-column history and no audit');
  console.log('   table, so the exact moment sync_enabled flipped is NOT recoverable.');
  if (mapRow.last_pushed_at && mapRow.updated_at) {
    const lp = parseUtc(mapRow.last_pushed_at), up = parseUtc(mapRow.updated_at);
    if (lp != null && up != null) {
      console.log('');
      console.log('   ORDERING: last_pushed_at is ' + (lp > up ? 'AFTER' : lp < up ? 'BEFORE' : 'EQUAL TO') + ' updated_at.');
      console.log('   If the push is AFTER the last admin edit, the push happened while the');
      console.log('   row already held its current sync_enabled value.');
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 2 · every queue row for the product
// ════════════════════════════════════════════════════════════════════════════
guard('queue', () => {
  section(`2 · QUEUE ROWS — eleme_sync_queue for product ${PRODUCT_ID}`);
  if (!has('eleme_sync_queue')) { console.log('   no eleme_sync_queue table'); return; }
  const rows = all('SELECT * FROM eleme_sync_queue WHERE product_id = ? ORDER BY id', PRODUCT_ID);
  console.log('   rows: ' + rows.length + '\n');
  for (const r of rows) {
    console.log(`   id=${r.id}  store=${r.store_code}  new_qty=${r.new_qty}  status=${r.status}  attempts=${r.attempts}`);
    console.log(`        created   ${shanghai(r.created_at)}   ${ageOf(r.created_at)}`);
    console.log(`        processed ${r.processed_at ? shanghai(r.processed_at) + '   ' + ageOf(r.processed_at) : '(never)'}`);
    console.log(`        last_error ${J(r.last_error)}`);
  }
  console.log('');
  console.log('   NOTE: the drain (scripts/eleme-daemon.js:464-480) selects on');
  console.log('   q.status/q.attempts and LEFT JOINs eleme_product_map with NO sync_enabled');
  console.log('   condition. sync_enabled is checked only when a row is ENQUEUED');
  console.log('   (lib/eleme-sync.js:46 and :73). A row queued while enabled therefore still');
  console.log('   pushes after the mapping is disabled.');
});

// ════════════════════════════════════════════════════════════════════════════
// 3 · sync log
// ════════════════════════════════════════════════════════════════════════════
guard('log', () => {
  section(`3 · ELEME SYNC LOG — most recent 25 lines touching product ${PRODUCT_ID}`);
  if (!has('eleme_sync_log')) { console.log('   no eleme_sync_log table'); return; }
  // detail is JSON carrying product_id; match on the JSON field rather than a
  // bare substring so 80 inside 180/800/a price cannot produce a false hit.
  const rows = all(
    `SELECT * FROM eleme_sync_log
      WHERE CAST(json_extract(detail, '$.product_id') AS INTEGER) = ?
      ORDER BY id DESC LIMIT 25`, PRODUCT_ID);
  if (rows.length) {
    for (const r of rows) {
      console.log(`   [${r.id}] ${shanghai(r.created_at)}  ${r.store_code}  ${r.event_type}/${r.status}`);
      console.log(`        detail ${J(r.detail)}`);
      if (r.error_msg) console.log(`        error  ${J(r.error_msg)}`);
    }
  } else {
    console.log('   no lines with json_extract(detail,"$.product_id") = ' + PRODUCT_ID);
  }
  // Widen once, honestly labelled, in case detail was ever written in another shape.
  const loose = all(
    `SELECT * FROM eleme_sync_log WHERE detail LIKE ? ORDER BY id DESC LIMIT 25`,
    `%"product_id":${PRODUCT_ID}%`);
  console.log('\n   (substring cross-check on \'"product_id":' + PRODUCT_ID + '\': ' + loose.length + ' line(s))');

  const totals = all(`SELECT status, COUNT(*) n, MAX(created_at) latest FROM eleme_sync_log GROUP BY status ORDER BY n DESC`);
  console.log('\n   whole-log status tally (all products):');
  for (const t of totals) console.log(`     ${String(t.status).padEnd(12)} ${String(t.n).padStart(6)}   latest ${shanghai(t.latest)}`);
});

// ════════════════════════════════════════════════════════════════════════════
// 4 · the match rule, run exactly as the push path runs it
// ════════════════════════════════════════════════════════════════════════════

// Verbatim from lib/eleme-browser.js:807-812. Returns EVERY hit; the real
// function returns the first and stops.
function looseHits(name, names) {
  const out = [];
  for (const k of names) {
    if (k === name || k.includes(name) || name.includes(k)) {
      out.push({ k, exact: k === name, catalogueContainsMapped: k.includes(name), mappedContainsCatalogue: name.includes(k) });
    }
  }
  return out;
}

let cacheRows = [];
guard('match', () => {
  section('4 · NAME RESOLUTION — lib/eleme-browser.js:807-812 applied to the stored name');
  if (!has('eleme_catalogue_cache')) { console.log('   no eleme_catalogue_cache table'); return; }
  const storeCode = mapRow ? mapRow.store_code : 'tianhe';
  cacheRows = all('SELECT * FROM eleme_catalogue_cache WHERE store_code = ? ORDER BY id', storeCode);
  const names = cacheRows.map(r => r.name);
  console.log('   store_code: ' + storeCode + '   cached listings: ' + names.length);
  const cachedAt = all('SELECT MIN(updated_at) a, MAX(updated_at) b FROM eleme_catalogue_cache WHERE store_code = ?', storeCode)[0];
  if (cachedAt) console.log('   cache written between ' + shanghai(cachedAt.a) + ' and ' + shanghai(cachedAt.b));

  const target = mapRow ? String(mapRow.eleme_name || '') : '';
  console.log('\n   mapped name: "' + target + '"   ' + bytesOf(target));

  const exact = names.filter(n => n === target);
  console.log('\n   step 1 — exact _foodCache.get(name)  : ' + (exact.length ? 'HIT' : 'MISS'));

  const hits = looseHits(target, names);
  console.log('   step 2 — _findByFuzzyName loose scan : ' + hits.length + ' hit(s)');
  if (!hits.length) {
    console.log('\n   → resolves to NOTHING. updateStock returns { ok:false, transient:true }');
    console.log('     at lib/eleme-browser.js:840 — the 195 failure mode.');
  } else {
    console.log('\n   FIRST hit in cache id order is what the real function would return');
    console.log('   (Map insertion order approximated by eleme_catalogue_cache.id):\n');
    hits.forEach((h, i) => {
      const row = cacheRows.find(r => r.name === h.k);
      const why = h.exact ? 'EXACT'
        : h.catalogueContainsMapped ? 'catalogue name CONTAINS mapped name'
        : 'mapped name CONTAINS catalogue name';
      console.log(`     ${i === 0 ? '→ ' : '  '}[${i + 1}] cache id=${row ? row.id : '?'}  "${h.k}"`);
      console.log(`          matched because: ${why}`);
      if (row) {
        console.log(`          item_global_id=${J(row.item_global_id)}  listing stock=${J(row.stock)}  updated ${shanghai(row.updated_at)}`);
        let specs = [];
        try { specs = JSON.parse(row.specs || '[]'); } catch (e) { specs = []; }
        if (Array.isArray(specs) && specs.length) {
          console.log(`          boxes: ${specs.length}`);
          specs.forEach((s, si) => console.log(`            box[${si + 1}] name="${J(s.name)}" specGlobalId=${J(s.specGlobalId)} price=${J(s.price)} stock=${J(s.stock)}`));
        }
      }
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 5 · what product 80 actually is, and what the mapping should have named
// ════════════════════════════════════════════════════════════════════════════
guard('product', () => {
  section(`5 · THE PRODUCT — store_products ${PRODUCT_ID}`);
  if (!has('store_products')) { console.log('   no store_products table'); return; }
  const cols = colsOf('store_products');
  const wanted = ['id', 'sku', 'name_cn', 'name_en', 'physical_qty', 'is_active', 'retail_store_id', 'updated_at']
    .filter(c => cols.includes(c));
  const p = one(`SELECT ${wanted.join(', ')} FROM store_products WHERE id = ?`, PRODUCT_ID);
  if (!p) { console.log('   no such product'); return; }
  for (const k of Object.keys(p)) kv(k, p[k]);
  if (mapRow && mapRow.last_pushed_qty != null) {
    console.log('');
    kv('last_pushed_qty', mapRow.last_pushed_qty);
    kv('physical_qty now', p.physical_qty);
    console.log('   → the two ' + (Number(mapRow.last_pushed_qty) === Number(p.physical_qty) ? 'AGREE' : 'DISAGREE'));
  }
  // Which cached listing does this product's own name point at, if any?
  if (cacheRows.length && p.name_cn) {
    const byOwnName = looseHits(String(p.name_cn), cacheRows.map(r => r.name));
    console.log('\n   for reference, the product\'s OWN name_cn "' + p.name_cn + '"');
    console.log('   loose-matches ' + byOwnName.length + ' cached listing(s)' + (byOwnName.length ? ':' : '.'));
    byOwnName.slice(0, 5).forEach(h => console.log('     "' + h.k + '"' + (h.exact ? '  [EXACT]' : '')));
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 6 · the same rule applied to EVERY mapping on the store
// ════════════════════════════════════════════════════════════════════════════
guard('fleet', () => {
  section('6 · EVERY MAPPING — exact hit, loose hit, or nothing');
  if (!has('eleme_product_map') || !cacheRows.length) { console.log('   prerequisites missing'); return; }
  const storeCode = mapRow ? mapRow.store_code : 'tianhe';
  const names = cacheRows.map(r => r.name);
  const cols = colsOf('eleme_product_map');
  const specSel = cols.includes('spec_id') ? 'm.spec_id AS spec_id' : 'NULL AS spec_id';
  const maps = all(
    `SELECT m.id, m.product_id, m.eleme_name, m.sync_enabled, m.last_pushed_qty, m.last_pushed_at,
            ${specSel},
            p.sku, p.name_cn
       FROM eleme_product_map m
       LEFT JOIN store_products p ON p.id = m.product_id
      WHERE m.store_code = ?
      ORDER BY m.id`, storeCode);

  let exactN = 0, looseN = 0, noneN = 0;
  const looseOnly = [], none = [];
  for (const m of maps) {
    const nm = String(m.eleme_name || '');
    if (!nm) { noneN++; none.push({ ...m, why: '(empty name)' }); continue; }
    if (names.includes(nm)) { exactN++; continue; }
    const hits = looseHits(nm, names);
    if (hits.length) { looseN++; looseOnly.push({ ...m, hits }); }
    else { noneN++; none.push({ ...m, why: 'no exact and no loose hit' }); }
  }
  console.log('   mappings on ' + storeCode + ': ' + maps.length);
  console.log('     resolve EXACTLY                       : ' + exactN);
  console.log('     resolve ONLY via the loose branch      : ' + looseN + '   ← writes to a listing nobody named');
  console.log('     resolve to nothing at all             : ' + noneN + '   ← the 195 failure mode');

  console.log('\n   ── mappings that resolve ONLY loosely, with what they would hit first:');
  if (!looseOnly.length) console.log('     (none)');
  for (const m of looseOnly) {
    const first = m.hits[0];
    const row = cacheRows.find(r => r.name === first.k);
    console.log(`     map id=${m.id} product ${m.product_id} sku=${J(m.sku)} sync_enabled=${m.sync_enabled}`);
    console.log(`         stored name  "${J(m.eleme_name)}"  (${String(m.eleme_name || '').length} chars)`);
    console.log(`         would hit    "${first.k}"  [${m.hits.length} candidate(s)]`);
    console.log(`                      cache id=${row ? row.id : '?'}  listing stock=${row ? J(row.stock) : '?'}`);
    console.log(`         last_pushed  ${J(m.last_pushed_qty)} at ${m.last_pushed_at ? shanghai(m.last_pushed_at) : 'never'}`);
    console.log(`         product name_cn "${J(m.name_cn)}"`);
  }

  console.log('\n   ── mappings that resolve to nothing:');
  if (!none.length) console.log('     (none)');
  for (const m of none) {
    console.log(`     map id=${m.id} product ${m.product_id} sku=${J(m.sku)} sync_enabled=${m.sync_enabled}  "${J(m.eleme_name)}"  ${m.why}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 7 · the Tzadziki spellings
// ════════════════════════════════════════════════════════════════════════════
guard('tzadziki', () => {
  section('7 · TZADZIKI SPELLINGS — 莳萝 vs 时萝, in the live catalogue');
  if (!cacheRows.length) { console.log('   no catalogue rows'); return; }
  const VARIANTS = ['莳萝', '时萝', '莆萝'];
  for (const v of VARIANTS) {
    console.log('\n   variant "' + v + '"   ' + bytesOf(v));
    let inNames = 0, inSpecs = [];
    for (const row of cacheRows) {
      if (String(row.name).includes(v)) { inNames++; console.log('     listing NAME contains it: cache id=' + row.id + '  "' + row.name + '"'); }
      let specs = [];
      try { specs = JSON.parse(row.specs || '[]'); } catch (e) { specs = []; }
      if (!Array.isArray(specs)) continue;
      specs.forEach((s, si) => {
        if (String(s && s.name || '').includes(v)) {
          inSpecs.push(`     box name contains it: "${row.name}" box[${si + 1}] "${s.name}"  specGlobalId=${J(s.specGlobalId)}  stock=${J(s.stock)}`);
        }
      });
    }
    console.log('     listing names containing it : ' + inNames);
    console.log('     BOX names containing it     : ' + inSpecs.length);
    inSpecs.forEach(l => console.log(l));
  }
  console.log('\n   Both spellings living in BOX names means both are on the live Eleme');
  console.log('   listings as Eleme serves them — the catalogue cache is a transcript of');
  console.log('   the merchant back-office, not a value we compose. Nothing was corrected.');

  // Do either spelling appear in anything WE store and match on?
  if (has('eleme_product_map')) {
    console.log('\n   ── do either appear in a stored mapping name (which we DO match on)?');
    for (const v of VARIANTS) {
      const m = all('SELECT id, product_id, eleme_name, sync_enabled FROM eleme_product_map WHERE eleme_name LIKE ?', `%${v}%`);
      console.log(`     "${v}": ${m.length} mapping(s)` + (m.length ? '' : ' — nothing of ours depends on this spelling'));
      for (const r of m) console.log(`       map id=${r.id} product ${r.product_id} enabled=${r.sync_enabled} "${r.eleme_name}"`);
    }
  }
});

section('DONE');
console.log('Nothing was written. Nothing was enqueued. No process was touched.');
db.close();
