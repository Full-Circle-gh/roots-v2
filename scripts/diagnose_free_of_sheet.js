/* What does the live catalogue say "free of", and how does it differ from the
 * label sheet Ash sent on 2026-09-22?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Ash sent final_labels__v2.xlsx with a corrected "Free of" column for 112
 * products and asked for the system to be brought in line. Before anything is
 * written, three things have to be known and none of them can be guessed:
 *
 *   1. WHICH ROWS MATCH. The sheet keys on a printed SKU ("2-140", "S(1-30)").
 *      A SKU that matches nothing is a row that would be silently skipped, and
 *      a silently skipped row is a label that stays wrong.
 *   2. WHAT WOULD BE LOST. The sheet's column only ever names four things —
 *      nuts, soy, gluten, 5 spice. The column in the database also carries
 *      `animal products`, `dairy` and `egg` (§148 added all three), plus a
 *      free-text tail the details panel parks anything it does not recognise
 *      in. A wholesale overwrite would drop every one of those claims.
 *   3. WHICH TABLE. `products` is the kitchen catalogue and `store_products`
 *      is the shop's; both carry a free_of column and the shop reads the
 *      second. A repair that writes one and not the other leaves the two
 *      disagreeing about the same jar.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 *   products.sku, products.free_of
 *   store_products.sku, store_products.free_of
 * NO CUSTOMER DATA of any kind: no orders, names, addresses or payments.
 *
 * ── WHAT IT PRINTS ─────────────────────────────────────────────────────────
 * Per table: how many sheet SKUs matched, which did not, and for every match a
 * before/after under BOTH candidate rules —
 *
 *   REPLACE  the sheet's four tokens become the whole value
 *   MERGE    the sheet's four tokens replace only those four; anything else
 *            already on the row (animal products, dairy, egg, free text) stays
 *
 * and a tally of exactly what REPLACE would remove that MERGE would keep. That
 * difference is the decision, and it is Ash's to make, so this prints it rather
 * than choosing.
 *
 * It changes nothing.
 *
 *   node scripts/diagnose_free_of_sheet.js
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const Database = require(`${HOME}/node_modules/better-sqlite3`);

// The sheet travels as JSON beside this script: the .xlsx cannot be read on the
// box, and a diagnostic that carries its own input is one a later reader can
// re-run and get the same answer from.
const SHEET = JSON.parse(fs.readFileSync(path.join(__dirname, 'free_of_sheet_2026-09-22.json'), 'utf8'));

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
  console.log('WARNING: this handle accepted a write. Stopping rather than reading live data.');
  process.exit(1);
} catch (e) {
  console.log('read-only proven — write rejected: ' + String(e.message).split('\n')[0] + '\n');
}

// The four the sheet speaks about. Everything else on a row is outside its
// scope by definition, which is what makes MERGE expressible at all.
const SHEET_TOKENS = ['nuts', 'soy', 'gluten', '5 spice'];
const isSheetToken = (t) => SHEET_TOKENS.includes(norm(t));
// "5spice", "5 Spice" and "5-spice" are the same claim written three ways;
// the store editor writes "5 spice" and that is the spelling kept here.
function norm(t) {
  const s = String(t || '').trim().toLowerCase();
  if (/^5[\s-]*spice$/.test(s)) return '5 spice';
  return s;
}
const splitFree = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

function tables() {
  const have = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
  return ['products', 'store_products'].filter(have);
}

// A printed SKU and a stored SKU can differ by case, spacing and the full-width
// brackets the sheet picked up from the office's keyboard. Fold all three
// before comparing, or a row that exists reads as missing.
const key = (s) => String(s || '').trim().toLowerCase()
  .replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '');

for (const table of tables()) {
  const cols = new Set(db.pragma(`table_info(${table})`).map(c => c.name));
  if (!cols.has('sku') || !cols.has('free_of')) {
    console.log(`\n### ${table}: no sku/free_of column — skipped\n`);
    continue;
  }
  const nameCol = cols.has('name_en') ? 'name_en' : 'sku';
  const rows = db.prepare(`SELECT id, sku, ${nameCol} AS name, free_of FROM ${table}`).all();
  const bySku = new Map();
  for (const r of rows) {
    if (!r.sku) continue;
    const k = key(r.sku);
    if (!bySku.has(k)) bySku.set(k, []);
    bySku.get(k).push(r);
  }

  console.log(`\n${'='.repeat(78)}\n### ${table} — ${rows.length} rows, ${bySku.size} distinct SKUs\n${'='.repeat(78)}`);

  const missing = [];
  const multi   = [];
  let matched = 0, sameUnderMerge = 0, changedUnderMerge = 0;
  const lostByReplace = new Map();   // token -> count of rows that would lose it
  const rowsLosing = [];

  for (const s of SHEET) {
    const hit = bySku.get(key(s.sku));
    if (!hit) { missing.push(s); continue; }
    if (hit.length > 1) multi.push({ sheet: s, rows: hit });
    for (const r of hit) {
      matched++;
      const cur  = splitFree(r.free_of);
      const kept = cur.filter(t => !isSheetToken(t));           // outside the sheet's scope
      const want = s.free_of.slice();                            // the sheet's four
      const replaceVal = want.join(',');
      const mergeVal   = want.concat(kept).join(',');
      const curVal     = cur.join(',');

      if (curVal === mergeVal) sameUnderMerge++; else changedUnderMerge++;

      for (const t of kept) {
        lostByReplace.set(t, (lostByReplace.get(t) || 0) + 1);
      }
      if (kept.length) rowsLosing.push({ sku: r.sku, name: r.name, kept });

      const mark = curVal === mergeVal ? '   ' : ' * ';
      console.log(`${mark}${String(r.sku).padEnd(12)} ${String(r.name || '').slice(0, 38).padEnd(38)}`);
      console.log(`      now     : ${curVal || '(blank)'}`);
      console.log(`      MERGE   : ${mergeVal || '(blank)'}`);
      if (mergeVal !== replaceVal) console.log(`      REPLACE : ${replaceVal || '(blank)'}`);
    }
  }

  console.log(`\n--- ${table}: summary ---`);
  console.log(`sheet rows            : ${SHEET.length}`);
  console.log(`matched product rows  : ${matched}`);
  console.log(`already correct       : ${sameUnderMerge}`);
  console.log(`would change (MERGE)  : ${changedUnderMerge}`);
  console.log(`sheet SKUs not found  : ${missing.length}`);
  for (const m of missing) console.log(`    not found: ${m.sku}  ${m.name}`);
  console.log(`sheet SKUs hitting >1 row : ${multi.length}`);
  for (const m of multi) console.log(`    ${m.sheet.sku} -> ids ${m.rows.map(r => r.id).join(', ')}`);

  console.log(`\nWhat REPLACE would delete that MERGE keeps:`);
  if (!lostByReplace.size) console.log('    nothing — no matched row carries a token outside the sheet\'s four');
  for (const [t, n] of [...lostByReplace].sort((a, b) => b[1] - a[1])) {
    console.log(`    "${t}" — on ${n} matched row${n === 1 ? '' : 's'}`);
  }

  // Rows the sheet leaves blank are their own question: blank can mean "free of
  // nothing" or "not filled in yet", and the two want opposite writes.
  const blanks = SHEET.filter(s => !s.free_of.length);
  if (blanks.length) {
    console.log(`\nSheet rows with an EMPTY "Free of" cell (${blanks.length}) — these would be`);
    console.log(`cleared under REPLACE and left alone under MERGE-skip-blank:`);
    for (const b of blanks) {
      const hit = bySku.get(key(b.sku));
      const now = hit ? hit.map(r => (r.free_of || '(blank)')).join(' | ') : '(sku not found)';
      console.log(`    ${String(b.sku).padEnd(12)} ${String(b.name).slice(0, 34).padEnd(34)} now: ${now}`);
    }
  }
}

// The catalogue at large: what tokens are in use, so a token the sheet never
// names is visible rather than inferred.
for (const table of tables()) {
  const cols = new Set(db.pragma(`table_info(${table})`).map(c => c.name));
  if (!cols.has('free_of')) continue;
  const counts = new Map();
  let filled = 0, total = 0;
  for (const r of db.prepare(`SELECT free_of FROM ${table}`).all()) {
    total++;
    const t = splitFree(r.free_of);
    if (t.length) filled++;
    for (const x of t) counts.set(x, (counts.get(x) || 0) + 1);
  }
  console.log(`\n### ${table}: every free_of token in use (${filled}/${total} rows carry one)`);
  for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  "${t}"`);
}

console.log('\ndone — nothing was written.');
