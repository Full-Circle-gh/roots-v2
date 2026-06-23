// Detect & repair product names that got duplicated/garbled on entry, e.g.
//   "云南玉芒干云南玉芒干"                         (exact double, no separator)
//   "Dehydrated Yu Mango Dehydrated Yu Mango"   (double with a space)
//   "Old FashOld Fashioned Oats ...ioned Oats"  (interleaved — NOT auto-fixable)
//
// These break Meituan sync (the daemon matches by name_cn/name_en, so a doubled
// name finds no listing -> "product not found on Meituan"). Generic: works for
// any tenant/product, no brand assumptions.
//
//   node scripts/fix_duplicated_product_names.js          # report only (dry run)
//   node scripts/fix_duplicated_product_names.js --apply  # fix the clean doubles
'use strict';

const path = require('path');
const fs   = require('fs');
const envFile = path.join(__dirname, '../.env');
try { require('dotenv').config({ path: envFile }); }
catch {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}
const db = require('../database');
const APPLY = process.argv.includes('--apply');

// Return the de-duplicated form if `s` is exactly one value repeated (either
// "AA" or "A<sep>A" for a single space/·/、/-/ separator), else null.
function deduped(s) {
  const t = String(s == null ? '' : s).trim();
  if (t.length < 2) return null;
  // exact double, no separator: "AA"
  if (t.length % 2 === 0) {
    const h = t.length / 2;
    if (t.slice(0, h) === t.slice(h)) return t.slice(0, h);
  }
  // double with a single-char separator: "A<sep>A"
  for (let i = 1; i < t.length - 1; i++) {
    const a = t.slice(0, i);
    if (t.slice(i + 1) === a && /[\s·、,\-/]/.test(t[i])) return a;
  }
  return null;
}

// A weaker signal: the same 4+ char run appears twice. Flags interleaved /
// partial garble for MANUAL review (we never auto-edit these).
function looksRepeated(s) {
  const t = String(s == null ? '' : s).trim();
  for (let len = Math.min(12, t.length >> 1); len >= 4; len--) {
    for (let i = 0; i + len * 2 <= t.length; i++) {
      const frag = t.slice(i, i + len);
      if (/^\s+$/.test(frag)) continue;
      if (t.indexOf(frag, i + len) !== -1) return frag;
    }
  }
  return null;
}

const rows = db.prepare(
  `SELECT id, name_cn, name_en FROM products
    WHERE COALESCE(is_active,1)=1 ORDER BY id`
).all();

const autoFix = [];   // { id, col, from, to }
const manual  = [];   // { id, col, value, frag }

for (const r of rows) {
  for (const col of ['name_cn', 'name_en']) {
    const val = r[col];
    if (!val) continue;
    const fixed = deduped(val);
    if (fixed && fixed !== val) { autoFix.push({ id: r.id, col, from: val, to: fixed }); continue; }
    const frag = looksRepeated(val);
    if (frag) manual.push({ id: r.id, col, value: val, frag });
  }
}

console.log(`scanned ${rows.length} active products\n`);

console.log(`== AUTO-FIXABLE (clean doubles): ${autoFix.length} ==`);
for (const f of autoFix) console.log(`  #${f.id} ${f.col}: "${f.from}"  ->  "${f.to}"`);

console.log(`\n== MANUAL REVIEW (repeated fragment, not a clean double): ${manual.length} ==`);
for (const m of manual) console.log(`  #${m.id} ${m.col}: "${m.value}"   (repeats "${m.frag}")`);

if (!APPLY) {
  console.log(`\n(dry run — re-run with --apply to write the ${autoFix.length} auto-fixes; manual ones are never auto-edited)`);
  process.exit(0);
}

let n = 0;
const tx = db.transaction(() => {
  for (const f of autoFix) {
    db.prepare(`UPDATE products SET ${f.col === 'name_cn' ? 'name_cn' : 'name_en'} = ? WHERE id = ?`)
      .run(f.to, f.id);
    n++;
  }
});
tx();
console.log(`\napplied ${n} fix(es). Manual list (${manual.length}) left untouched — send it back and I'll patch each.`);
process.exit(0);
