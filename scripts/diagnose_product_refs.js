#!/usr/bin/env node
/**
 * diagnose_product_refs.js — everything the database knows about ONE product,
 * and everything that would break if it were removed.
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_product_refs.js
 *   Target:  PRODUCT_ID env var, default 195.
 *
 * READ-ONLY, AND IT PROVES IT. Every database file is opened with
 * `readonly: true, fileMustExist: true` and a write is attempted and REQUIRED to
 * fail before a single row is read; a connection that accepts the write aborts
 * the run with exit 2. There is no UPDATE, DELETE, INSERT, ALTER or CREATE in
 * this file except that one probe, which exists to be rejected. It computes a
 * deletion ORDER and prints it; it never deletes anything, and it starts, stops
 * and restarts no process.
 *
 * WHY THIS EXISTS
 * ---------------
 * scripts/diagnose_channel_queue.js says which targets a channel badge is
 * counting. It cannot say whether the product behind one of them is a live item
 * people are ordering or a dead row nobody would miss, and it cannot say what
 * else points at it. Those are the two questions that have to be answered before
 * anyone touches a product, and the second one is the one that bites.
 *
 * THE REFERENCE SCAN IS DISCOVERED, NOT LISTED
 * --------------------------------------------
 * Section 5 does NOT carry a hand-written table list. It walks sqlite_master,
 * asks PRAGMA table_info for every column, and counts rows on ANY column whose
 * name looks product-referencing — whether or not a FOREIGN KEY was ever
 * declared. That ordering is the whole point: a hand-written list can only
 * contain the references someone remembered, and PRAGMA foreign_key_list can
 * only contain the ones someone declared. The dangerous reference is the one
 * that is neither — a plain INTEGER column holding an id with no constraint
 * behind it, which deletes cleanly and orphans silently. Every column found is
 * reported with its declared ON DELETE action, or with NO DECLARED FK in
 * capitals when there is none.
 *
 * JSON references are checked too. store_products.bundle_items is a JSON array
 * of `{id, qty}` component references (database.js:4001-4009) — a real reference
 * that no schema tool can see, because it is text. It is parsed here rather than
 * pattern-matched, so "195" inside 1195 or a price cannot produce a false hit.
 *
 * TWO ID SPACES, AND THIS DOES NOT PRETEND OTHERWISE
 * --------------------------------------------------
 * `products` (kitchen catalogue) and `store_products` (storefront fork) are
 * separate id spaces that were 1:1 at the fork (database.js:4290-4310). Some FKs
 * still point at products(id) — retail_order_items.product_id among them — while
 * the channel maps point at store_products(id). This script reads BOTH rows,
 * prints both, and diffs their common columns rather than assuming the id means
 * the same thing in both. Where a count could be against either space, that is
 * said out loud instead of being resolved by guesswork.
 *
 * Every tenant database is scanned, same as diagnose_channel_queue.js, because
 * the app reads through tdb() and a script that opened only data/roots.db could
 * report a confident "no references" from the wrong file.
 *
 * Sections are independently guarded: one missing table or older column drops
 * that section with a printed reason rather than costing the other four on a
 * one-shot production query.
 *
 * EXIT CODES
 *   0  ran
 *   2  REFUSED: a connection accepted a write, or no database could be read.
 *      A read-only check that cannot prove it is read-only must refuse, and a
 *      check that read nothing must never look like a clean bill.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DEPLOY_ROOT = process.env.ROOTS_DEPLOY_ROOT || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(DEPLOY_ROOT, 'data', 'roots.db');
const PRODUCT_ID = Number(process.env.PRODUCT_ID || 195);

const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3')); }
})();

const NOW = Date.now();

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' with no zone marker and IS
// UTC. Parsing it bare reads hours off — the trap lib/channel-sync-stale.js
// parseUtc() and the Eleme activity log both had to fix. Force UTC.
function parseUtc(stamp) {
  if (stamp == null) return null;
  const t = Date.parse(String(stamp).replace(' ', 'T') + (String(stamp).includes('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? t : null;
}
function ageOf(stamp) {
  const t = parseUtc(stamp);
  if (t == null) return 'unparseable';
  const m = Math.round((NOW - t) / 60_000);
  if (Math.abs(m) < 90) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ${h % 24}h ago`;
}
function shanghai(stamp) {
  const t = parseUtc(stamp);
  if (t == null) return '—';
  return new Date(t + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') + ' +08';
}

const J = v => (v === null || v === undefined ? 'NULL' : String(v));
function section(t) { console.log('\n' + '═'.repeat(78) + '\n══ ' + t + '\n'); }
function sub(t) { console.log('\n── ' + t); }
function dumpRows(rows, indent = '   ') {
  if (!rows || !rows.length) { console.log(indent + '(no rows)'); return; }
  rows.forEach((r, i) => {
    console.log(`${indent}[${i + 1}]`);
    for (const k of Object.keys(r)) console.log(`${indent}    ${k.padEnd(24)} ${J(r[k])}`);
  });
}

// A column name that plausibly holds a product id. Deliberately generous: a
// false positive costs one COUNT(*) and a printed zero; a false negative is a
// reference nobody knew about, which is the failure this whole section exists
// to prevent.
const PRODUCT_COL = /^(product_id|substitute_product_id|.*_product_id|product)$/i;

function candidates() {
  const dataDir = path.dirname(DB_PATH);
  const list = [DB_PATH];
  try {
    const tenants = path.join(dataDir, 'tenants');
    for (const f of fs.readdirSync(tenants)) if (f.endsWith('.db')) list.push(path.join(tenants, f));
  } catch (e) { /* single tenant */ }
  return list.filter(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
}

console.log('diagnose_product_refs.js — one product, and everything pointing at it');
console.log('target PRODUCT_ID: ' + PRODUCT_ID);
console.log('run at (UTC):      ' + new Date(NOW).toISOString());
console.log('run at (+08):      ' + new Date(NOW + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
console.log('primary db:        ' + DB_PATH);

const files = candidates();
console.log('\ndatabase files to scan (' + files.length + '):');
for (const f of files) console.log('   ' + f);
if (!files.length) {
  console.error('FATAL: no readable database file. Refusing to report zero references from nothing.');
  process.exit(2);
}

let examined = 0;

for (const file of files) {
  section('DATABASE  ' + file);

  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { console.log('   cannot open: ' + e.message + ' — skipped'); continue; }

  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; console.log('   read-only PROVEN — write rejected: ' + e.message); }
  if (!proven) {
    console.error('FATAL: the connection accepted a write on ' + file + '. Aborting.');
    process.exit(2);
  }
  examined++;

  const tables = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  const tableNames = new Set(tables.map(t => t.name));
  const has = t => tableNames.has(t);
  const cols = t => { try { return db.pragma(`table_info(${t})`).map(c => c.name); } catch (e) { return []; } };
  const guard = (title, fn) => {
    try { fn(); } catch (e) { console.log('   SECTION FAILED (' + title + '): ' + e.message); }
  };
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (e) { return null; } };
  const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (e) { return []; } };

  if (!has('store_products') && !has('products')) {
    console.log('   neither products nor store_products — not an application database, skipped');
    db.close();
    continue;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1 · identity, in both id spaces
  // ══════════════════════════════════════════════════════════════════════════
  let spRow = null, pRow = null;
  guard('identity', () => {
    section(`1 · IDENTITY — product_id ${PRODUCT_ID} in both id spaces`);

    spRow = has('store_products') ? one('SELECT * FROM store_products WHERE id = ?', PRODUCT_ID) : null;
    pRow  = has('products')       ? one('SELECT * FROM products WHERE id = ?', PRODUCT_ID)       : null;

    console.log(`   store_products row: ${spRow ? 'PRESENT' : 'ABSENT'}`);
    console.log(`   products row:       ${pRow ? 'PRESENT' : 'ABSENT'}`);
    console.log('   (separate id spaces, 1:1 at the fork — database.js:4290-4310)');

    if (spRow) { sub('store_products row, verbatim'); dumpRows([spRow]); }
    if (pRow)  { sub('products row, verbatim');       dumpRows([pRow]); }

    if (spRow && pRow) {
      sub('do the two rows agree? (common columns only)');
      const common = Object.keys(spRow).filter(k => k in pRow);
      const diff = common.filter(k => String(J(spRow[k])) !== String(J(pRow[k])));
      console.log(`   common columns: ${common.length}   differing: ${diff.length}`);
      if (!diff.length) console.log('   → identical on every shared column');
      for (const k of diff) {
        console.log(`     ${k}`);
        console.log(`         store_products: ${J(spRow[k])}`);
        console.log(`         products:       ${J(pRow[k])}`);
      }
    }

    // Which store(s) hold it — store_products has no store column; the stock
    // table is what ties a product to a location.
    if (has('retail_store_stock') && has('retail_stores')) {
      sub('which store(s) — retail_store_stock joined to retail_stores');
      dumpRows(all(`
        SELECT s.code AS store_code, s.name_en AS store_name, s.is_active AS store_is_active,
               ss.store_id, ss.product_id, ss.physical_qty,
               ${cols('retail_store_stock').includes('reserved_qty') ? 'ss.reserved_qty,' : ''}
               ${cols('retail_store_stock').includes('updated_at') ? 'ss.updated_at' : "'' AS updated_at"}
          FROM retail_store_stock ss
          JOIN retail_stores s ON s.id = ss.store_id
         WHERE ss.product_id = ?
         ORDER BY s.sort_order, s.id`, PRODUCT_ID));
    }

    // Category name, when the schema carries a category table.
    const spCols = cols('store_products');
    const catCol = ['category_id', 'category'].find(c => spCols.includes(c));
    if (spRow && catCol) {
      sub(`category (store_products.${catCol} = ${J(spRow[catCol])})`);
      if (has('retail_categories')) dumpRows(all('SELECT * FROM retail_categories WHERE id = ?', spRow[catCol]));
      else if (has('categories'))   dumpRows(all('SELECT * FROM categories WHERE id = ?', spRow[catCol]));
      else console.log('   (no category table in this schema — raw value above)');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2 · is it real trade
  // ══════════════════════════════════════════════════════════════════════════
  guard('trade', () => {
    section('2 · IS IT REAL TRADE — stock, orders, bundle membership');

    if (has('retail_store_stock')) {
      const st = all('SELECT store_id, physical_qty FROM retail_store_stock WHERE product_id = ?', PRODUCT_ID);
      console.log('   physical stock rows: ' + (st.length
        ? st.map(r => `store_id ${r.store_id} → ${J(r.physical_qty)}`).join(' | ') : '(none)'));
    }

    // Orders. retail_order_items.product_id declares a FK to products(id)
    // (database.js:1354) while the channel maps key off store_products(id) — the
    // two spaces were 1:1 at the fork, so this count is reported as "id 195 in
    // whichever space this column means" rather than silently resolved.
    if (has('retail_order_items') && has('retail_orders')) {
      sub('orders containing this product_id (retail_order_items → retail_orders.placed_at)');
      console.log('   NOTE: retail_order_items.product_id declares FK → products(id) (database.js:1354),');
      console.log('         not store_products(id). Counted on the raw id; see the fork note above.');
      for (const [label, days] of [['last 30 days', 30], ['last 90 days', 90], ['all time', null]]) {
        const where = days == null ? '' : ` AND o.placed_at >= datetime('now', '-${days} days')`;
        const r = one(`
          SELECT COUNT(DISTINCT o.id) AS orders, COUNT(*) AS lines,
                 SUM(oi.qty) AS units, MAX(o.placed_at) AS last_placed
            FROM retail_order_items oi
            JOIN retail_orders o ON o.id = oi.order_id
           WHERE oi.product_id = ?${where}`, PRODUCT_ID);
        console.log(`   ${String(label).padEnd(14)} orders=${J(r && r.orders)}  lines=${J(r && r.lines)}`
          + `  units=${J(r && r.units)}  most recent placed_at=${J(r && r.last_placed)}`
          + (r && r.last_placed ? `  → ${shanghai(r.last_placed)} (${ageOf(r.last_placed)})` : ''));
      }
      sub('the 10 most recent order lines, verbatim');
      dumpRows(all(`
        SELECT oi.id AS line_id, oi.order_id, o.order_no, o.status, o.placed_at,
               oi.product_id, oi.sku, oi.name_cn, oi.name_en, oi.qty, oi.unit_price, oi.line_total
          FROM retail_order_items oi
          JOIN retail_orders o ON o.id = oi.order_id
         WHERE oi.product_id = ?
         ORDER BY o.placed_at DESC, oi.id DESC LIMIT 10`, PRODUCT_ID));
    }

    // Bundle membership. Two mechanisms, one of which is JSON and invisible to
    // every schema tool.
    sub('bundle membership');
    if (has('store_products') && cols('store_products').includes('bundle_items')) {
      const rows = all("SELECT id, sku, name_cn, name_en, bundle_mode, bundle_items FROM store_products WHERE bundle_items IS NOT NULL AND TRIM(bundle_items) <> ''");
      const hits = [];
      for (const r of rows) {
        let items = null;
        try { items = JSON.parse(r.bundle_items); } catch (e) { continue; }
        if (!Array.isArray(items)) continue;
        // Parsed, not pattern-matched: "195" inside 1195 or a price cannot hit.
        const m = items.filter(it => it && Number(it.id) === PRODUCT_ID);
        if (m.length) hits.push({ ...r, matched_components: JSON.stringify(m) });
      }
      console.log(`   store_products.bundle_items (JSON, NO foreign key) — bundles containing it: ${hits.length}`);
      dumpRows(hits);
    } else {
      console.log('   store_products.bundle_items: column absent on this schema');
    }
    if (has('meituan_bundle_components')) {
      const mb = all(`
        SELECT c.bundle_id, c.product_id, c.qty, b.meituan_name, b.store_code, b.sync_enabled
          FROM meituan_bundle_components c
          LEFT JOIN meituan_bundles b ON b.id = c.bundle_id
         WHERE c.product_id = ?`, PRODUCT_ID);
      console.log(`   meituan_bundle_components rows: ${mb.length}`);
      dumpRows(mb);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3 · the Eleme situation
  // ══════════════════════════════════════════════════════════════════════════
  guard('eleme', () => {
    section('3 · ELEME — mapping, queue row, catalogue cache, log');

    let names = [];
    if (has('eleme_product_map')) {
      sub('eleme_product_map');
      const maps = all('SELECT * FROM eleme_product_map WHERE product_id = ?', PRODUCT_ID);
      dumpRows(maps);
      for (const m of maps) {
        if (m.eleme_name) names.push({ via: 'eleme_product_map.eleme_name', name: m.eleme_name, store: m.store_code });
        console.log(`   → has it EVER pushed? last_pushed_at=${J(m.last_pushed_at)} `
          + `last_pushed_qty=${J(m.last_pushed_qty)} — `
          + (m.last_pushed_at == null && m.last_pushed_qty == null
              ? 'NO. Never once landed on Eleme.'
              : `yes, last at ${shanghai(m.last_pushed_at)} (${ageOf(m.last_pushed_at)})`));
      }
    }
    if (spRow && spRow.name_cn) names.push({ via: 'store_products.name_cn', name: spRow.name_cn, store: null });

    if (has('eleme_sync_queue')) {
      sub('eleme_sync_queue — every row for this product, newest first');
      dumpRows(all('SELECT * FROM eleme_sync_queue WHERE product_id = ? ORDER BY id DESC', PRODUCT_ID));
    }

    if (has('eleme_catalogue_cache')) {
      sub('eleme_catalogue_cache — lookup under both keys');
      // A stale cache and a genuinely missing listing look identical from a miss
      // alone, so the cache's own freshness is reported beside the misses.
      const fresh = all('SELECT store_code, COUNT(*) AS n, MAX(updated_at) AS t FROM eleme_catalogue_cache GROUP BY store_code');
      console.log('   cache size + last refresh, per store:');
      if (!fresh.length) console.log('     (cache is EMPTY — every lookup below misses for that reason alone)');
      for (const f of fresh) {
        console.log(`     ${String(f.store_code).padEnd(12)} entries=${J(f.n)}  last refresh=${J(f.t)} UTC`
          + `  → ${shanghai(f.t)}  (${ageOf(f.t)})`);
      }
      for (const k of names) {
        const stores = k.store ? [k.store] : all('SELECT DISTINCT store_code FROM eleme_catalogue_cache').map(r => r.store_code);
        for (const sc of (stores.length ? stores : ['(no store)'])) {
          const c = one('SELECT * FROM eleme_catalogue_cache WHERE store_code = ? AND name = ?', sc, k.name);
          console.log(`   [${sc}] "${k.name}" (${k.via}) → ${c ? 'FOUND' : 'NO ENTRY'}`);
          if (c) dumpRows([c], '       ');
        }
      }
      // A near-miss is the difference between "not listed" and "listed under a
      // slightly different string", which is the whole question here.
      sub('near-miss scan — cached names sharing a 4+ char run with either lookup name');
      const allNames = all('SELECT store_code, name, stock, updated_at FROM eleme_catalogue_cache');
      const near = [];
      for (const cn of allNames) {
        for (const k of names) {
          const a = String(cn.name), b = String(k.name);
          let run = 0;
          for (let i = 0; i < b.length && !run; i++) {
            for (let len = Math.min(12, b.length - i); len >= 4; len--) {
              if (a.includes(b.substr(i, len))) { run = len; break; }
            }
          }
          if (run >= 4) { near.push({ ...cn, shares_with: b, run_len: run }); break; }
        }
      }
      dumpRows(near);
    }

    if (has('eleme_sync_log')) {
      sub('eleme_sync_log — lines mentioning this product id or either name, most recent 25');
      const like = names.map(() => 'detail LIKE ?').join(' OR ');
      const params = names.map(k => `%${k.name}%`);
      const rows = all(
        `SELECT id, store_code, event_type, status, detail, error_msg, created_at
           FROM eleme_sync_log
          WHERE detail LIKE ?${like ? ' OR ' + like : ''}
          ORDER BY id DESC LIMIT 25`,
        `%"product_id":${PRODUCT_ID}%`, ...params);
      console.log(`   matched ${rows.length} line(s)`);
      dumpRows(rows);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4 · the other channels
  // ══════════════════════════════════════════════════════════════════════════
  guard('other channels', () => {
    section('4 · OTHER CHANNELS — does it sync fine anywhere else?');
    for (const [label, map, queue] of [
      ['MEITUAN', 'meituan_product_map', 'meituan_sync_queue'],
      ['GZ GROCERY (guanyi)', 'guanyi_product_map', 'guanyi_sync_queue'],
    ]) {
      sub(label + ' — mapping');
      if (has(map)) dumpRows(all(`SELECT * FROM ${map} WHERE product_id = ?`, PRODUCT_ID));
      else console.log('   table absent');

      sub(label + ' — queue history (every row, newest first, capped at 20)');
      if (has(queue)) {
        const rows = all(`SELECT * FROM ${queue} WHERE product_id = ? ORDER BY id DESC LIMIT 20`, PRODUCT_ID);
        const tot = one(`SELECT COUNT(*) AS n FROM ${queue} WHERE product_id = ?`, PRODUCT_ID);
        console.log(`   total rows ever: ${J(tot && tot.n)}   showing ${rows.length}`);
        const byStatus = all(`SELECT status, COUNT(*) AS n, MAX(created_at) AS last FROM ${queue} WHERE product_id = ? GROUP BY status`, PRODUCT_ID);
        for (const b of byStatus) console.log(`     ${String(b.status).padEnd(12)} n=${J(b.n)}  last=${J(b.last)}`);
        dumpRows(rows);
      } else console.log('   table absent');
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5 · blast radius
  // ══════════════════════════════════════════════════════════════════════════
  guard('blast radius', () => {
    section('5 · BLAST RADIUS — every reference to this id, declared or not');
    console.log('   Discovered by walking sqlite_master + PRAGMA table_info, NOT from a written');
    console.log('   list. Any column whose name looks product-referencing is counted, whether or');
    console.log('   not a FOREIGN KEY was declared. NO DECLARED FK is the dangerous case: it');
    console.log('   deletes cleanly and orphans silently.');

    const findings = [];
    for (const t of tables) {
      let fks = [];
      try { fks = db.pragma(`foreign_key_list(${t.name})`); } catch (e) { fks = []; }
      const fkByCol = {};
      for (const f of fks) fkByCol[f.from] = f;

      for (const c of cols(t.name)) {
        if (!PRODUCT_COL.test(c)) continue;
        const r = one(`SELECT COUNT(*) AS n FROM "${t.name}" WHERE "${c}" = ?`, PRODUCT_ID);
        if (!r) continue;
        const fk = fkByCol[c];
        findings.push({
          table: t.name,
          column: c,
          rows_referencing: r.n,
          references: fk ? `${fk.table}(${fk.to || 'id'})` : null,
          on_delete: fk ? (fk.on_delete || 'NO ACTION') : null,
          declared_fk: !!fk,
        });
      }
    }

    findings.sort((a, b) => (b.rows_referencing - a.rows_referencing) || a.table.localeCompare(b.table));

    sub('every product-referencing column in the schema (all counts, including zero)');
    console.log('   ' + 'table'.padEnd(30) + 'column'.padEnd(24) + 'rows'.padEnd(8) + 'references'.padEnd(24) + 'ON DELETE');
    console.log('   ' + '-'.repeat(100));
    for (const f of findings) {
      console.log('   ' + f.table.padEnd(30) + f.column.padEnd(24)
        + String(f.rows_referencing).padEnd(8)
        + String(f.declared_fk ? f.references : '— none —').padEnd(24)
        + (f.declared_fk ? f.on_delete : 'NO DECLARED FK'));
    }

    const hits = findings.filter(f => f.rows_referencing > 0);
    sub(`columns that ACTUALLY hold this id: ${hits.length}`);
    for (const f of hits) {
      console.log(`   ${f.table}.${f.column} — ${f.rows_referencing} row(s), `
        + (f.declared_fk ? `FK → ${f.references} ON DELETE ${f.on_delete}` : 'NO DECLARED FK'));
    }

    sub('UNPROTECTED — rows that a delete would orphan or that would block it');
    const unprotected = hits.filter(f => !f.declared_fk || /NO ACTION|RESTRICT/i.test(f.on_delete));
    if (!unprotected.length) console.log('   (none — every column holding this id has a CASCADE or SET NULL)');
    for (const f of unprotected) {
      console.log(`   !! ${f.table}.${f.column} — ${f.rows_referencing} row(s) — `
        + (f.declared_fk
            ? `FK declared but ON DELETE ${f.on_delete}: the delete is REFUSED while these exist (with foreign_keys=ON)`
            : 'NO DECLARED FK: nothing stops the delete and nothing cleans these up — they become orphans'));
    }

    // The JSON reference again, because no schema walk can see it.
    if (has('store_products') && cols('store_products').includes('bundle_items')) {
      sub('JSON references (invisible to any schema walk) — store_products.bundle_items');
      const rows = all("SELECT id, sku, name_en, bundle_items FROM store_products WHERE bundle_items IS NOT NULL AND TRIM(bundle_items) <> ''");
      let n = 0;
      for (const r of rows) {
        let items = null;
        try { items = JSON.parse(r.bundle_items); } catch (e) { continue; }
        if (Array.isArray(items) && items.some(it => it && Number(it.id) === PRODUCT_ID)) {
          n++; console.log(`   !! store_products id=${J(r.id)} (${J(r.sku)} ${J(r.name_en)}) lists it as a component`);
        }
      }
      console.log(`   bundles referencing it in JSON: ${n}` + (n ? '  — NO foreign key exists for these' : ''));
    }

    sub('DELETION ORDER, if it came to that — PRINTED ONLY, NOTHING IS EXECUTED');
    if (!hits.length) {
      console.log('   Nothing holds this id. store_products, then products, would be the whole job.');
    } else {
      console.log('   Children first, parents last. Within a tier the order does not matter.');
      let tier = 1;
      const leaf = hits.filter(f => !/^(store_products|products)$/.test(f.table));
      const histories = leaf.filter(f => /_sync_queue$|_sync_log$|_order_items$|_ledger$|_reservations$/.test(f.table));
      const maps = leaf.filter(f => /_product_map$|_bundle_components$|_substitutes$/.test(f.table));
      const rest = leaf.filter(f => !histories.includes(f) && !maps.includes(f));
      for (const [name, set] of [['history / transactional', histories], ['mappings + component links', maps], ['everything else holding the id', rest]]) {
        if (!set.length) continue;
        console.log(`   ${tier++}. ${name}`);
        for (const f of set) console.log(`        ${f.table}  (${f.rows_referencing} row(s) on ${f.column})`);
      }
      console.log(`   ${tier++}. store_products  (id ${PRODUCT_ID})`);
      console.log(`   ${tier}. products        (id ${PRODUCT_ID}, if the row exists and is not shared)`);
      console.log('   Any JSON bundle_items listed above must be edited by hand — no cascade reaches them.');
    }
  });

  db.close();
}

section('DONE');
console.log(`databases examined: ${examined} of ${files.length}`);
if (!examined) {
  console.error('FATAL: no database could be opened and proven read-only. Refusing to report.');
  process.exit(2);
}
console.log('Nothing was written. No process was touched. No deletion was performed.');
