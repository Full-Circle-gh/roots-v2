#!/usr/bin/env node
/**
 * diagnose_eleme_unmatched_lines.js — why does the Eleme resolver miss these?
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_eleme_unmatched_lines.js
 *
 * READ-ONLY, and it proves that on the connection before reading anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * scripts/diagnose_channel_order_deduction.js established WHAT is wrong: seven
 * of the last twenty channel orders carry an Eleme line that resolved to no
 * product, so the ingest skipped it and the shelf was never decremented. It did
 * not establish WHY those particular listings miss, and the answer decides the
 * fix — a mapping the operator has to make, or a resolver that should have
 * matched them and does not.
 *
 * So this takes the names Eleme actually sent (out of the `order_unsynced` rows
 * the ingest wrote) and walks each one through the SAME four questions
 * routes/eleme-internal.js asks, printing what each branch would have found:
 *
 *   0. a claimed 规格 in eleme_product_map
 *   1. an inline SKU token — AND THIS IS THE ONE UNDER SUSPICION. The Meituan
 *      resolver digs a "(\d+-\d+)" token out of the listing name when the
 *      platform sends no skuCode (routes/meituan-internal.js, the `skuToken`
 *      line). The Eleme resolver has no such step: it reads item.sku and
 *      nothing else. Two of the six live misses carry exactly that token in
 *      their name — "…中230g 1-130" and "…230g 大 (1-190)" — so if a
 *      store_products row holds those SKUs, the Eleme copy is missing a step
 *      its twin already has, and that is a bug rather than absent data.
 *   2. eleme_product_map by listing name
 *   3. unique active name match — and WHICH rows it finds, because "ambiguous"
 *      only says there was more than one, never which ones, and that is the
 *      difference between a resolver to fix and a catalogue to tidy.
 *
 * THE QUERIES ARE COPIES, not calls into the resolver, and deliberately so:
 * routes/eleme-internal.js opens require('../database') at module load, which
 * under the ro-query harness is a stub. A copy that can be read beside the
 * original is worth more here than a shared import that cannot run at all.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP      = process.env.ROOTS_APP || '/root/roots-v2';
const LOG_TAIL = parseInt(process.env.UNMATCHED_LOG_TAIL, 10) || 20000;

let Database;
try { Database = require(path.join(APP, 'node_modules', 'better-sqlite3')); }
catch (e) { console.error('cannot load better-sqlite3: ' + e.message); process.exit(2); }

const FILE = process.env.ROOTS_DB || path.join(APP, 'data', 'roots.db');
if (!fs.existsSync(FILE)) { console.error(`no database at ${FILE}`); process.exit(2); }

let db;
try { db = new Database(FILE, { readonly: true, fileMustExist: true }); }
catch (e) { console.error(`cannot open ${FILE} read-only: ${e.message}`); process.exit(2); }
let proven = false;
try { db.exec('CREATE TABLE __ro_probe__ (x)'); } catch (_) { proven = true; }
if (!proven) { console.error('FATAL: the connection accepted a write — reading nothing'); process.exit(2); }

const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { console.error(`  ! ${e.message}`); return []; } };

// Copied verbatim from routes/eleme-internal.js. If that one changes, this stops
// describing it — which is why the copy is named as a copy here and in the header.
function normName(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[\s　]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

console.log(`${FILE}`);
console.log('='.repeat(78));

// ── The names Eleme actually sent, from the ingest's own warn rows ───────────
// Bounded by rowid tail: eleme_sync_log carries the every-ten-seconds queue
// drain and has no index at all.
const rows = all(`
  SELECT store_code, detail, error_msg, created_at
    FROM eleme_sync_log
   WHERE id > (SELECT COALESCE(MAX(id), 0) - ? FROM eleme_sync_log)
   ORDER BY id DESC
`, LOG_TAIL).filter(r => String(r.error_msg || '').includes('not synced'));

// One entry per DISTINCT listing name — the same listing misses on order after
// order (杏仁酱 has done it twice in eight days), and the question is about the
// listing, not the occurrence.
const seen = new Map();
for (const r of rows) {
  let detail = null;
  try { detail = JSON.parse(r.detail || '{}'); } catch (_) { /* older rows */ }
  for (const u of (detail && detail.unresolved) || []) {
    const name = String(u.name || '').trim();
    if (!name) continue;
    if (!seen.has(name)) seen.set(name, { name, reason: u.reason, sku: u.sku || null, store: r.store_code, when: r.created_at, times: 0 });
    seen.get(name).times++;
  }
}

console.log(`\n${seen.size} distinct listing name(s) have failed to resolve, from ${rows.length} warn row(s).\n`);

// Which stores exist, so the per-store map lookups below can be aimed. Eleme
// orders in the survey were all store 1.
const stores = all('SELECT id, code, name FROM retail_stores ORDER BY id');
console.log('Stores: ' + (stores.map(s => `${s.id}=${s.code || s.name}`).join(', ') || '(none)') + '\n');

// What a SKU actually looks like here, so "no product holds 1-130" can be told
// apart from "SKUs are not written in that shape at all".
const skuShape = all(`
  SELECT sku FROM store_products
   WHERE sku IS NOT NULL AND sku <> '' AND is_active = 1
   ORDER BY id DESC LIMIT 12
`).map(r => r.sku);
console.log(`Sample active SKUs: ${skuShape.join(', ') || '(none)'}`);
const tokenSkus = all(`
  SELECT COUNT(*) n FROM store_products
   WHERE sku GLOB '*[0-9]-[0-9]*'
`)[0];
console.log(`store_products rows whose sku looks like N-N: ${tokenSkus ? tokenSkus.n : '?'}\n`);

for (const entry of [...seen.values()]) {
  const { name, reason, times, store, when } = entry;
  console.log('-'.repeat(78));
  console.log(`"${name}"`);
  console.log(`  ingest said: ${reason}   ·   seen ${times}×   ·   store ${store}   ·   last ${when}`);

  // 1. THE INLINE TOKEN — the branch Meituan has and Eleme does not.
  const token = (name.match(/\d+-\d+/) || [])[0] || null;
  if (!token) {
    console.log('  inline N-N token: none in this name');
  } else {
    const bySku = all('SELECT id, name_cn, name_en, is_active FROM store_products WHERE sku = ?', token);
    console.log(`  inline N-N token: "${token}" → ${bySku.length} store_products row(s)` +
                (bySku.length ? ': ' + bySku.map(p => `#${p.id} ${p.name_en}${p.is_active ? '' : ' (INACTIVE)'}`).join(', ')
                              : ' — no product holds that SKU'));
    if (bySku.length === 1) {
      console.log('    ↑ ONE match. The Meituan resolver would have taken this branch and deducted.');
    }
  }

  // 0/2. The map, per store, both ways round.
  for (const s of stores) {
    const maps = all(`
      SELECT p.id, p.name_en, m.eleme_name, m.spec_name, m.units_per_pack
        FROM eleme_product_map m
        JOIN store_products p ON p.id = m.product_id
       WHERE m.retail_store_id = ? AND m.eleme_name IS NOT NULL
    `, s.id);
    if (!maps.length) continue;
    const wanted = normName(name);
    const exact = maps.filter(m => normName(m.eleme_name) === wanted);
    const part  = maps.filter(m => {
      const mn = normName(m.eleme_name);
      return mn && mn !== wanted && (mn.includes(wanted) || wanted.includes(mn));
    });
    console.log(`  eleme_product_map @store ${s.id}: ${maps.length} mapped listing(s); ` +
                `exact ${exact.length}, substring ${part.length}`);
    for (const m of exact.concat(part).slice(0, 4)) {
      console.log(`      → #${m.id} ${m.name_en}  (mapped as "${m.eleme_name}"${m.spec_name ? `, spec "${m.spec_name}"` : ''})`);
    }
  }

  // 3. The last-resort name match, and WHICH rows made it ambiguous.
  const clean = String(name).replace(/\([^)]*\)/g, ' ').trim();
  const cjk = (clean.match(/[一-鿿]+/) || [])[0];
  const en  = (clean.match(/[A-Za-z][A-Za-z ]+/) || [])[0];
  let matches = [];
  let via = null;
  if (cjk) { matches = all('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_cn LIKE ?', `%${cjk}%`); via = `name_cn LIKE %${cjk}%`; }
  if (matches.length !== 1 && en) { matches = all('SELECT id, name_cn, name_en FROM store_products WHERE is_active = 1 AND name_en LIKE ?', `%${en.trim()}%`); via = `name_en LIKE %${en.trim()}%`; }
  console.log(`  name match (${via || 'no usable fragment'}): ${matches.length} row(s)` +
              (matches.length ? ' — ' + matches.slice(0, 6).map(p => `#${p.id} ${p.name_en}`).join(', ') : ''));
  if (matches.length > 1) console.log('    ↑ more than one, so the resolver refuses rather than guessing. This is the "ambiguous".');
}

console.log('\n' + '-'.repeat(78));
console.log('done');
try { db.close(); } catch (_) {}
