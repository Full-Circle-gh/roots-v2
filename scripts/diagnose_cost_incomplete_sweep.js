#!/usr/bin/env node
/**
 * diagnose_cost_incomplete_sweep.js — what a catalogue-wide
 * "this cost is not complete" sweep would do, before anything is written.
 *
 *   Actions → "Read-only prod query" → scripts/diagnose_cost_incomplete_sweep.js
 *
 * WHY THIS EXISTS
 * ---------------
 * Ash's instruction, 2026-09-14: mark cost_incomplete on every product except
 * forty named SKUs (lib/cost-complete-keep-list.js). The instruction is an
 * exception list of forty strings typed by hand, and the three things that can
 * go wrong with it are invisible from a checkout:
 *
 *   1. A named SKU that matches no row — a typo, or a product whose sku is
 *      spelled differently in the database than on the page it was read from.
 *      Ticking the catalogue while that one goes unmatched marks a product Ash
 *      explicitly excluded, and nothing in the write would say so.
 *   2. A named SKU that matches MORE than one row.
 *   3. Rows with no sku at all, which no exception list can name. They are
 *      counted and listed here rather than swept in silently.
 *
 * So this prints the full plan: every row that would be ticked, every row that
 * would be left, every keeper that could not be found, and the near misses for
 * each one. Nobody should press the apply button on the one-off until the
 * "COULD NOT BE FOUND" section is empty or has been ruled on.
 *
 * READ-ONLY, AND IT PROVES IT. Every database file is opened with
 * `readonly: true, fileMustExist: true` and a write is attempted and REQUIRED
 * to fail before a single row is read; a connection that accepts the write
 * aborts the run with exit 2. There is no UPDATE, DELETE, INSERT, ALTER or
 * CREATE in this file except that one probe, which exists to be rejected.
 *
 * TENANTS ARE LISTED BUT NOT PLANNED FOR. Ash's catalogue is Roots, tenant #1,
 * in data/roots.db. Other tenant files (lib/tenant-db.js) are separate
 * businesses whose costs are not Ash's to tag. Each is opened and COUNTED so
 * the report says out loud how much catalogue this sweep is not touching —
 * a number nobody can see from the checkout — but no plan is computed for it
 * and scripts/oneoff_mark_cost_incomplete.js writes to the primary db only.
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

const Database = (() => {
  try { return require(path.join(HOME, 'node_modules', 'better-sqlite3')); }
  catch (e) { return require(path.join(DEPLOY_ROOT, 'node_modules', 'better-sqlite3')); }
})();

const { KEEP_SKUS, skuKey, isKeeper } = require(path.join(HOME, 'lib', 'cost-complete-keep-list.js'));

const J = v => (v === null || v === undefined ? 'NULL' : String(v));
const section = t => console.log('\n' + '═'.repeat(78) + '\n══ ' + t + '\n');
const sub = t => console.log('\n── ' + t);

// The three states of the tag, spelled the way database.js:5516-5531 does.
const state = v => (v === null || v === undefined ? 'NULL (unanswered)' : v === 1 ? '1 (incomplete)' : `${v} (complete)`);

function openRo(file) {
  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { console.log('   cannot open: ' + e.message + ' — skipped'); return null; }
  let proven = false;
  try { db.exec('CREATE TABLE __ro_probe__ (x)'); }
  catch (e) { proven = true; console.log('   read-only PROVEN — write rejected: ' + e.message); }
  if (!proven) {
    console.error('FATAL: the connection accepted a write on ' + file + '. Aborting.');
    process.exit(2);
  }
  return db;
}

function tenantFiles() {
  const list = [];
  try {
    const dir = path.join(path.dirname(DB_PATH), 'tenants');
    for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.db')) list.push(path.join(dir, f));
  } catch (e) { /* single tenant */ }
  return list.filter(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
}

console.log('diagnose_cost_incomplete_sweep.js — the plan for a catalogue-wide cost_incomplete sweep');
console.log('run at (UTC):      ' + new Date().toISOString());
console.log('primary db:        ' + DB_PATH);
console.log('keeper SKUs given: ' + KEEP_SKUS.length);

const db = openRo(DB_PATH);
if (!db) { console.error('FATAL: primary database unreadable. Refusing to report a plan from nothing.'); process.exit(2); }

const hasTable = n => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(n);
if (!hasTable('store_products')) {
  console.error('FATAL: no store_products table in ' + DB_PATH + '. Wrong database.');
  process.exit(2);
}
const cols = db.pragma('table_info(store_products)').map(c => c.name);
if (!cols.includes('cost_incomplete')) {
  console.error('FATAL: store_products has no cost_incomplete column — the migration has not run on this box.');
  process.exit(2);
}

// ══════════════════════════════════════════════════════════════════════════
// 1 · the catalogue as it stands
// ══════════════════════════════════════════════════════════════════════════
section('1 · THE CATALOGUE NOW');

const rows = db.prepare(`
  SELECT id, sku, name_en, name_cn, COALESCE(is_active, 1) AS is_active,
         COALESCE(is_published, 0) AS is_published, unit_cost, sell_price,
         cost_incomplete, variant_group_id
    FROM store_products
   ORDER BY sku IS NULL, sku, id`).all();

const active = rows.filter(r => r.is_active === 1);
const inactive = rows.filter(r => r.is_active !== 1);
const tally = list => ({
  null_: list.filter(r => r.cost_incomplete === null || r.cost_incomplete === undefined).length,
  zero: list.filter(r => r.cost_incomplete === 0).length,
  one: list.filter(r => r.cost_incomplete === 1).length,
});
const t = tally(rows), ta = tally(active);

console.log(`   store_products rows           ${rows.length}`);
console.log(`     active   (is_active = 1)    ${active.length}`);
console.log(`     inactive (is_active = 0)    ${inactive.length}   ← deleted products; routes/retail.js nulls their sku`);
console.log(`     published                   ${rows.filter(r => r.is_published === 1).length}`);
console.log(`\n   cost_incomplete, ALL rows     NULL ${t.null_}   0 ${t.zero}   1 ${t.one}`);
console.log(`   cost_incomplete, ACTIVE rows  NULL ${ta.null_}   0 ${ta.zero}   1 ${ta.one}`);
console.log(`\n   rows with NULL/blank sku      ${rows.filter(r => !r.sku).length}  (active: ${active.filter(r => !r.sku).length})`);

// ══════════════════════════════════════════════════════════════════════════
// 2 · did every keeper land on a row?
// ══════════════════════════════════════════════════════════════════════════
section('2 · THE FORTY KEEPERS — DID EACH ONE FIND ITS PRODUCT?');

const byKey = new Map();
for (const r of rows) {
  const k = skuKey(r.sku);
  if (k == null) continue;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(r);
}

const found = [], missing = [], ambiguous = [];
for (const s of KEEP_SKUS) {
  const hits = byKey.get(skuKey(s)) || [];
  if (!hits.length) missing.push(s);
  else {
    found.push({ s, hits });
    if (hits.length > 1) ambiguous.push({ s, hits });
  }
}

sub(`matched: ${found.length} of ${KEEP_SKUS.length}`);
console.log('    keeper     | id   | act | tag                | name');
for (const { s, hits } of found) {
  for (const r of hits) {
    console.log(`    ${String(s).padEnd(10)} | ${String(r.id).padEnd(4)} | ${r.is_active === 1 ? ' y ' : ' n '} | ${state(r.cost_incomplete).padEnd(18)} | ${J(r.name_en)}`);
  }
}

sub(`COULD NOT BE FOUND: ${missing.length}`);
if (!missing.length) console.log('    (none — every keeper matched a row)');
for (const s of missing) {
  console.log(`\n    ${s}  — no row carries this sku.`);
  // Near misses, so a typo or a different spelling can be ruled on rather than
  // guessed at: same digits ignoring punctuation, or the sku as a substring.
  const digits = String(s).replace(/\D/g, '');
  const near = rows.filter(r => {
    if (!r.sku) return false;
    const k = skuKey(r.sku);
    return k.includes(skuKey(s)) || (digits && String(r.sku).replace(/\D/g, '') === digits);
  });
  if (!near.length) console.log('      near misses: (none)');
  else for (const r of near) console.log(`      near miss: id ${r.id}  sku ${J(r.sku)}  act ${r.is_active}  ${J(r.name_en)}`);
}

sub(`matched MORE THAN ONE row: ${ambiguous.length}`);
if (!ambiguous.length) console.log('    (none)');
for (const { s, hits } of ambiguous) console.log(`    ${s} → ids ${hits.map(r => r.id).join(', ')}`);

const keptRows = active.filter(r => isKeeper(r.sku));
const targets = active.filter(r => !isKeeper(r.sku));
const wouldChange = targets.filter(r => r.cost_incomplete !== 1);
const alreadyOne = targets.filter(r => r.cost_incomplete === 1);
const clearingAKeeper = keptRows.filter(r => r.cost_incomplete === 1);

// ══════════════════════════════════════════════════════════════════════════
// 2b · the keepers' siblings — where an exclusion can be undone by the fold
// ══════════════════════════════════════════════════════════════════════════
section("2b · KEEPERS' SIBLINGS — THE EXCLUSIONS THE PRODUCTS LIST WOULD UNDO");
console.log("   The products list does not paint one mark per row. _paCostIncomplete()");
console.log("   (public/retail-admin/09-products.js) folds a variant family into ONE cell");
console.log("   and marks it IF ANY MEMBER IS TAGGED — deliberately, because the folded");
console.log("   figure already has the partial cost inside it.");
console.log('');
console.log("   So a keeper sharing a variant_group_id with a row this sweep marks is not");
console.log("   actually excluded from the page: its own tag stays clear, and its cell");
console.log("   shows the mark anyway. That is the sweep quietly overriding the list it");
console.log("   was given, which is the one outcome worth stopping for.");
console.log('');
console.log("   The same thing happens by NAME rather than by grouping: a single-unit");
console.log("   `S(3-251)` or a multipack `(3-210) X5` is the keeper's product in another");
console.log("   pack. Whether those count as the keeper is Ash's call, not this script's,");
console.log("   so they are listed and nothing is assumed.");

sub('by variant_group_id — a keeper folded together with a row that WOULD be marked');
const byGroup = new Map();
for (const r of active) {
  if (r.variant_group_id == null || r.variant_group_id === '') continue;
  const g = String(r.variant_group_id);
  if (!byGroup.has(g)) byGroup.set(g, []);
  byGroup.get(g).push(r);
}
let foldHits = 0;
for (const r of keptRows) {
  if (r.variant_group_id == null || r.variant_group_id === '') continue;
  const sibs = (byGroup.get(String(r.variant_group_id)) || []).filter(s => s.id !== r.id && !isKeeper(s.sku));
  if (!sibs.length) continue;
  foldHits++;
  console.log(`\n    keeper ${J(r.sku)} (id ${r.id}, group ${J(r.variant_group_id)}) — ${J(r.name_en)}`);
  for (const s of sibs) console.log(`      sibling WOULD BE MARKED: id ${s.id}  sku ${J(s.sku)}  ${J(s.name_en)}`);
}
if (!foldHits) console.log('    (none — no keeper shares a variant group with a row this sweep marks)');

sub("by sku text — rows naming a keeper's code inside their own sku");
// S(1-220), (3-210) X5, （4-680）+（4-690） — the same goods in another pack. The
// digits are matched rather than the punctuation: the catalogue spells these
// with ASCII and full-width brackets interchangeably, and `1-30` must not match
// inside `1-300`, so each candidate code is bounded by a non-digit or an end.
const codeIn = (sku, keeper) => {
  const t = skuKey(sku), k = skuKey(keeper);
  if (t == null || t === k) return false;
  const i = t.indexOf(k);
  if (i < 0) return false;
  const after = t[i + k.length];
  return after === undefined || !/[0-9]/.test(after);
};
let textHits = 0;
for (const r of targets) {
  const named = KEEP_SKUS.filter(k => codeIn(r.sku, k));
  if (!named.length) continue;
  textHits++;
  console.log(`    id ${String(r.id).padEnd(4)}  sku ${J(r.sku).padEnd(18)}  names keeper(s) ${named.join(', ').padEnd(16)}  ${J(r.name_en)}`);
}
if (!textHits) console.log('    (none)');

// ══════════════════════════════════════════════════════════════════════════
// 3 · what the sweep would write
// ══════════════════════════════════════════════════════════════════════════
section('3 · WHAT THE SWEEP WOULD WRITE (active rows only)');

console.log(`   active rows                          ${active.length}`);
console.log(`   left alone (a named keeper)          ${keptRows.length}`);
console.log(`   would be marked cost_incomplete = 1  ${targets.length}`);
console.log(`     of those, already 1 (no change)    ${alreadyOne.length}`);
console.log(`     of those, actually written         ${wouldChange.length}`);
console.log(`\n   keepers currently tagged 1           ${clearingAKeeper.length}   ← see section 4`);
console.log(`   inactive rows, untouched             ${inactive.length}`);

console.log(`\n   The ${wouldChange.length} rows are listed in the appendix at the foot of this report.`);

sub(`active rows with NO sku — an exception list cannot name these (${active.filter(r => !r.sku).length})`);
const noSku = active.filter(r => !r.sku);
if (!noSku.length) console.log('    (none)');
for (const r of noSku) console.log(`    id ${String(r.id).padEnd(4)}  pub ${r.is_published}  cost ${J(r.unit_cost)}  ${J(r.name_en)} / ${J(r.name_cn)}`);

// ══════════════════════════════════════════════════════════════════════════
// 4 · the keepers that are already tagged
// ══════════════════════════════════════════════════════════════════════════
section('4 · KEEPERS ALREADY TAGGED 1 — A SECOND DECISION, NOT PART OF THE FIRST');
console.log('   Ash asked for every product EXCEPT these to be marked. That says what to');
console.log('   do to the others; it does not say whether a keeper carrying an existing');
console.log('   tag (from the 2026-08 seed, or set by hand) should be CLEARED. The');
console.log('   one-off leaves them exactly as they are and reports them here, because');
console.log('   clearing a tag somebody set on purpose is the one move in this sweep that');
console.log('   cannot be read back off the page afterwards.\n');
if (!clearingAKeeper.length) console.log('   (none — no keeper carries a tag)');
for (const r of clearingAKeeper) {
  console.log(`   id ${String(r.id).padEnd(4)}  sku ${J(r.sku).padEnd(10)}  cost ${J(r.unit_cost).padEnd(7)}  ${J(r.name_en)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 5 · other tenants, counted and not planned for
// ══════════════════════════════════════════════════════════════════════════
section('5 · OTHER TENANT DATABASES — COUNTED, NOT TOUCHED');
const tenants = tenantFiles();
if (!tenants.length) console.log('   (no data/tenants/*.db on this box)');
for (const f of tenants) {
  console.log('\n   ' + f);
  const tdb = openRo(f);
  if (!tdb) continue;
  try {
    const n = tdb.prepare('SELECT COUNT(*) AS n FROM store_products WHERE COALESCE(is_active,1) = 1').get().n;
    const tagged = tdb.prepare('SELECT COUNT(*) AS n FROM store_products WHERE cost_incomplete = 1 AND COALESCE(is_active,1) = 1').get().n;
    console.log(`      ${n} active product(s), ${tagged} already tagged — this sweep writes none of them`);
  } catch (e) { console.log('      cannot count: ' + e.message); }
  tdb.close();
}

// ══════════════════════════════════════════════════════════════════════════
// APPENDIX · every row the sweep would change
// ══════════════════════════════════════════════════════════════════════════
//
// LAST ON PURPOSE. This is the longest part of the report and the least
// decision-bearing — the counts and the four exception sections above are what
// anyone rules on. A run's log is read from the end, and burying sections 2b
// through 5 under two hundred rows is how the one section that can stop a
// sweep goes unread. It cost a re-run to learn that.
section('APPENDIX · THE ' + wouldChange.length + ' ROW(S) THAT WOULD CHANGE');
console.log('    id   | sku        | from               | cost    | name');
for (const r of wouldChange) {
  console.log(`    ${String(r.id).padEnd(4)} | ${J(r.sku).padEnd(10)} | ${state(r.cost_incomplete).padEnd(18)} | ${J(r.unit_cost).padEnd(7)} | ${J(r.name_en)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// VERDICT · the whole report in twenty lines, printed last
// ══════════════════════════════════════════════════════════════════════════
//
// A run's log is read from the end, and this report is six hundred lines long.
// Everything below is already stated above; it is repeated here so that the
// numbers and the blockers can be read without paging through the appendix.
// Nothing is computed here that is not computed above.
section('VERDICT');
console.log(`   active products                  ${active.length}`);
console.log(`   keepers named / matched          ${KEEP_SKUS.length} / ${found.length}`);
console.log(`   would be marked                  ${targets.length}   (${wouldChange.length} actually written)`);
console.log(`   left alone                       ${keptRows.length}`);
console.log('');
console.log(`   BLOCKER · keepers matching no row         ${missing.length}${missing.length ? '  → ' + missing.join(', ') : ''}`);
console.log(`   BLOCKER · keepers matching several rows   ${ambiguous.length}${ambiguous.length ? '  → ' + ambiguous.map(a => a.s).join(', ') : ''}`);
console.log(`   RULE ON · keeper folded with a marked row ${foldHits}`);
console.log(`   RULE ON · rows naming a keeper's code     ${textHits}`);
console.log(`   RULE ON · keepers already tagged 1        ${clearingAKeeper.length}${clearingAKeeper.length ? '  → ' + clearingAKeeper.map(r => r.sku).join(', ') : ''}`);
console.log(`   RULE ON · active rows with no sku         ${noSku.length}${noSku.length ? '  → ids ' + noSku.map(r => r.id).join(', ') : ''}`);
console.log('');
console.log(`   ${missing.length || ambiguous.length ? 'DO NOT APPLY until the blockers above are ruled on.' : 'No blocker: every keeper matched exactly one row.'}`);

console.log('\n' + '═'.repeat(78));
console.log('Read-only. Nothing was written. Run scripts/oneoff_mark_cost_incomplete.js');
console.log('via Actions → "One-off prod repair" (dry run first) to act on this plan.\n');
db.close();
