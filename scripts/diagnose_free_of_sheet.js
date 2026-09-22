/* What does the live catalogue say "free of", and how far is it from the four
 * flags Ash says are the only ones there should be?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Ash sent final_labels__v2.xlsx on 2026-09-22 with a corrected "Free of"
 * column for 112 products, and then, asked whether the sheet should replace the
 * whole value or only the part it speaks about:
 *
 *   *"nuts, soy, gluten, 5 spice. - those are the one that needed. nothing
 *   else, everywhere"*
 *
 * So the job is not only "copy the sheet in". Three flags the catalogue carries
 * today — `animal products`, `dairy` and `egg`, all three added in §148 — are
 * retired. That is a bigger write than the sheet alone: it reaches every
 * product, not just the 112 the sheet names.
 *
 * Nothing is written until the size of that is known, and it cannot be guessed:
 *
 *   1. WHICH SHEET ROWS MATCH. The sheet keys on a printed SKU ("2-140",
 *      "S(1-30)"). A SKU that matches nothing is a label that stays wrong and
 *      nobody notices, so the misses are printed by name.
 *   2. WHICH TABLE. `products` is the kitchen catalogue and `store_products`
 *      the shop's; both carry a free_of column and the shop reads the second.
 *      A repair that writes one and not the other leaves the two disagreeing
 *      about the same jar.
 *   3. HOW MANY PRODUCTS OUTSIDE THE SHEET carry a retired flag, and what else
 *      is parked in that column — the details panel drops anything it does not
 *      recognise into a free-text tail, so the column can hold strings no list
 *      ever offered.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 *   products.sku, products.free_of
 *   store_products.sku, store_products.free_of
 * NO CUSTOMER DATA of any kind: no orders, names, addresses or payments.
 *
 * ── WHY THE SHEET IS INLINE ────────────────────────────────────────────────
 * ro-query.yml copies exactly ONE file to the box — the script named in the
 * dispatch. A sibling .json is not staged and the first run died on that. The
 * sheet therefore travels inside the script, one line per product, and
 * scripts/test_free_of_sheet_table.js holds it to the .json the office's
 * spreadsheet was read into, so the two cannot drift apart unnoticed.
 *
 * It changes nothing.
 *
 *   node scripts/diagnose_free_of_sheet.js
 */
'use strict';

const path = require('path');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const Database = require(`${HOME}/node_modules/better-sqlite3`);

// ── THE SHEET ──────────────────────────────────────────────────────────────
// final_labels__v2.xlsx, sheet "final", columns A (SKU) and H (Free of), as
// sent 2026-09-22. `sku|comma,separated,flags`; an empty right-hand side is an
// empty cell in the sheet and is kept that way on purpose — see BLANKS below.
// Mirrored in scripts/free_of_sheet_2026-09-22.json; the test holds them equal.
const SHEET_ROWS = [
  '2-140|nuts,soy,5 spice',             // Masala Chai Latte
  '2-170|nuts,soy,gluten,5 spice',      // Carrot-Ginger Juice
  '2-180|nuts,soy,gluten,5 spice',      // Celerybration Juice
  '2-160|nuts,soy,gluten,5 spice',      // Green Glow Juice
  '2-70|nuts,soy,gluten,5 spice',       // Lemongrass Kombucha
  '2-60|nuts,soy,gluten,5 spice',       // Lemongrass Kombucha
  '2-120|nuts,soy,gluten,5 spice',      // Mango Kombucha
  '2-130|nuts,soy,gluten,5 spice',      // Mango Kombucha
  '2-80|nuts,soy,gluten,5 spice',       // Passion Fruit Kombucha
  '2-90|nuts,soy,gluten,5 spice',       // Passion Fruit Kombucha
  '2-100|nuts,soy,gluten,5 spice',      // Mix Berries Kombucha
  '2-110|nuts,soy,gluten,5 spice',      // Mix Berries Kombucha
  '4-360|soy,gluten,5 spice',           // Calm Buckwheat Granola (No Sugar)
  '4-240|soy,5 spice',                  // Crunchy Granola
  '2-290|nuts,soy,gluten,5 spice',      // Jumbo Medjool Dates
  '2-291|nuts,soy,gluten,5 spice',      // Deri Dates
  '2-280|nuts,soy,gluten,5 spice',      // Nour Dates
  '2-270|nuts,soy,gluten,5 spice',      // Dried Pineapple Rings
  '2-260|nuts,soy,gluten,5 spice',      // Dried Sweet Banana
  '2-250|nuts,soy,gluten,5 spice',      // Dried Baby Banana
  '4-210|nuts,soy,gluten,5 spice',      // Dried Sweet Mango
  '2-230|nuts,soy,gluten,5 spice',      // Dried Dragon Fruit
  '2-220|nuts,soy,gluten,5 spice',      // Sun-Dried Apricots
  '4-350|nuts,soy,gluten,5 spice',      // Soft Dried Apples
  '4-320|nuts,soy,gluten,5 spice',      // Whole Dried Blueberries (No Sugar)
  '2-210|nuts,soy,gluten,5 spice',      // Crunchy Jujube Crisps
  '2-480|nuts,soy,gluten,5 spice',      // Jackfruit Chips
  '1-100|nuts,soy,gluten,5 spice',      // Blueberry Chia Jam
  '1-110|nuts,soy,gluten,5 spice',      // Strawberry-Lemon Chia Jam
  '1-60|nuts,soy,gluten,5 spice',       // Cherry Ginger Jam
  '2-450|soy,gluten,5 spice',           // Hazelnut-Chocolate Spread
  '2-420|soy,gluten,5 spice',           // Maple Cinnamon Almond Butter
  '2-430|soy,gluten,5 spice',           // Maple Cinnamon Almond Butter
  '4-670|gluten,5 spice,soy',           // Peanut Butter (100% Peanuts)
  '4-680|gluten,5 spice,soy',           // Peanut Butter (100% Peanuts)
  '2-440|soy,gluten,5 spice',           // Roasted Hazelnut Butter
  '2-470|gluten,5 spice,soy',           // Creamy Cashew Butter
  '2-410|gluten,5 spice,soy',           // Almond Butter
  '2-400|soy,gluten,5 spice',           // Almond Butter
  '4-690|soy,gluten,5 spice',           // Crunchy Peanut Butter
  '2-320|soy,gluten,5 spice',           // Walnuts
  '4-310|soy,gluten',                   // Parmesnuts (Parmesan）
  '1-220|nuts,soy,gluten',              // Pickled Onions
  '1-250|nuts,soy,gluten',              // Kalamata & Green Olive Mix
  '4-100|nuts,gluten,5 spice',          // Fermented Tofu （Oil Free）
  '1-240|nuts,soy,gluten',              // Harissa Chilli Paste
  '1-225|nuts,soy,gluten',              // Zhoug — Green Chilli Dip
  '1-80|nuts,soy,gluten',               // Olive 'n' Cream
  '1-30|gluten,soy',                    // Tzatziki
  '1-90|gluten,soy,5 spice',            // Classic Cashew Sour Cream
  '1-40|soy,gluten,5 spice',            // Za'atar Labneh
  '1-50|gluten',                        // Chickpea Salad
  '1-20|soy,gluten',                    // Arugula-Basil Pesto
  '1-70|soy,gluten',                    // Garlic Dill Sour Cream
  '1-15|soy,gluten',                    // Baked Camembert Roasted Garlic Spread
  '1-210|soy,gluten,5 spice',           // Strawberry Coconut Parfait
  '1-140|soy,gluten,5 spice',           // Probiotic Coconut Yogurt - Plain Flavor
  '1-10|nuts,soy,gluten,5 spice',       // Hummus Asli
  '1-160|soy,gluten,5 spice',           // Probiotic Coconut Yogurt - Vanilla Flavor
  '1-190|soy,gluten,5 spice',           // Probiotic Coconut Yogurt - Peach Flavor
  '1-130|soy,gluten,5 spice',           // Probiotic Coconut Yogurt - Plain Flavor
  '1-150|soy,gluten,5 spice',           // Probiotic Coconut Yogurt - Vanilla Flavor
  '1-180|soy,gluten,5 spice',           // Probiotic Coconut Yogurt -Peach Flavor
  '1-290|gluten,nuts,soy,5 spice',      // Ready-to-Eat Mix Quinoa
  '1-280|gluten,nuts,soy,5 spice',      // Ready-to-Eat Brown Rice
  '1-120|nuts,soy,5 spice',             // Apple Pie Overnight Oats
  '1-320|',                             // Thai Buckwheat Noodle Salad
  '1-310|gluten',                       // Beet Salad
  '1-330|nuts,soy',                     // Tabbouleh Bowl
  '1-300|nuts,soy,5 spice',             // Quinoa Salad
  '1-400|nuts,soy,gluten',              // Nourish Beans ＆ Veggie Soup
  '1-460|nuts,soy,gluten',              // Red Lentil Soup
  '1-360|nuts,soy,gluten,5 spice',      // Herbal Nourish Soup
  '1-370|nuts,soy,gluten',              // Roasted Pumpkin Soup
  '1-380|gluten,soy',                   // Sweet Potato & Cauliflower Curry
  '1-410|5 spice',                      // Tofu Banh Mi Wrap
  '1-430|nuts',                         // Shawarma Wrap
  '1-420|nuts,soy',                     // Falafel Wrap
  '1-440|',                             // Pesto 'Chicken' Wrap
  '1-226|gluten',                       // Cashew Camembert
  '3-30|',                              // Choco-Hazel Bars
  '1-211|gluten,5 spice,soy',           // Medjool Boat
  '3-200|soy,5 spice',                  // Sunny Lemon Bars
  '3-20|soy,gluten,5 spice',            // Choco Hemp Protein Bites
  '3-190|soy,5 spice',                  // Snackers (Peanut-Caramel Bar)
  '3-10|soy,gluten,5 spice',            // Mango Protein Bites
  '1-270|soy,5 spice',                  // Energy Cubes
  '1-260|soy,5 spice',                  // Energy Cubes
  '4-270|nuts,soy,5 spice',             // Whole-Wheat Crisp Crackers
  '4-250|nuts,soy,gluten,5 spice',      // Tortilla Chips
  '4-545|nuts,soy,gluten,5 spice',      // BioCurcumin+ (Organic)
  '4-500|nuts,soy,gluten,5 spice',      // Powerhouse Greens Blend
  '4-460|nuts,soy,gluten,5 spice',      // Organic Turmeric Powder
  '4-470|nuts,soy,gluten,5 spice',      // Organic Spirulina Powder
  '4-410|nuts,soy,gluten,5 spice',      // Organic Beetroot Powder
  '4-490|nuts,soy,gluten,5 spice',      // Organic Pea Protein
  '4-620|nuts,gluten,5 spice',          // Organic Soy Protein
  '4-480|nuts,soy,gluten,5 spice',      // Organic Hemp Protein
  '4-381|nuts,soy,gluten,5 spice',      // Pure Creatine Monohydrate (Unflavoured)
  'S(1-30)|gluten',                     // Tzatziki
  'S(1-220)|nuts,soy,gluten',           // Pickled Onions
  'S(4-360)|soy,gluten',                // Calm Buckwheat Granola (No Sugar)
  'S(3-250)|nuts,soy,5 spice',          // Hearty Rye & Whole Wheat Bread
  'S(1-240)|nuts,soy,gluten',           // Harissa Chilli Paste
  'S(4-240)|soy,5 spice',               // Crunchy Granola
  'S(3-251)|nuts,soy,5 spice',          // Whole-Wheat Pita
  '4-230|nuts,soy,gluten,5 spice',      // California Raisins (No Sugar)
  '4-220|nuts,soy,gluten,5 spice',      // Whole Cranberries (No Sugar)
  '3-250|nuts,soy,5 spice',             // Hearty Rye & Whole Wheat Bread
  'S(3-252)|nuts,soy,gluten,5 spice',   // GF Buckwheat Bread
  '3-252|nuts,soy,gluten,5 spice',      // GF Buckwheat Bread
  '3-251|nuts,soy,5 spice',             // Whole-Wheat Pita
];

const SHEET = SHEET_ROWS.map((line) => {
  const [sku, flags] = line.split('|');
  return { sku, free_of: (flags || '').split(',').map(s => s.trim()).filter(Boolean) };
});

// The four that stay. Everything else in the column is retired.
const KEEP = ['nuts', 'soy', 'gluten', '5 spice'];
// "5spice", "5 Spice" and "5-spice" are one claim written three ways. The store
// editor writes "5 spice" and that spelling is the one kept.
function norm(t) {
  const s = String(t || '').trim().toLowerCase();
  return /^5[\s-]*spice$/.test(s) ? '5 spice' : s;
}
const isKeeper = (t) => KEEP.includes(norm(t));
const splitFree = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

// A printed SKU and a stored SKU differ by case, spacing and the full-width
// brackets the office's keyboard produces. Fold all three or a row that exists
// reads as missing.
const key = (s) => String(s || '').trim().toLowerCase()
  .replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
  console.log('WARNING: this handle accepted a write. Stopping rather than reading live data.');
  process.exit(1);
} catch (e) {
  console.log('read-only proven — write rejected: ' + String(e.message).split('\n')[0] + '\n');
}

function tables() {
  const have = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
  return ['products', 'store_products'].filter(have);
}

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

  const sheetHit = new Set();          // ids the sheet reaches
  const missing = [], multi = [];
  let same = 0, changed = 0;

  console.log('\n-- rows the sheet names (* = would change) --');
  for (const s of SHEET) {
    const hit = bySku.get(key(s.sku));
    if (!hit) { missing.push(s); continue; }
    if (hit.length > 1) multi.push({ sheet: s, rows: hit });
    for (const r of hit) {
      sheetHit.add(r.id);
      const curVal  = splitFree(r.free_of).join(',');
      const wantVal = s.free_of.join(',');
      if (curVal === wantVal) { same++; continue; }
      changed++;
      console.log(` * ${String(r.sku).padEnd(12)} ${String(r.name || '').slice(0, 36).padEnd(36)}`);
      console.log(`      now : ${curVal || '(blank)'}`);
      console.log(`      new : ${wantVal || '(blank)'}`);
    }
  }

  // Everything the sheet does NOT name still has to lose the retired flags.
  // This is the half of the job the sheet cannot show, and it is the larger half.
  console.log('\n-- rows the sheet does NOT name, carrying something retired --');
  let outsideChanged = 0;
  const retiredCounts = new Map();
  for (const r of rows) {
    if (sheetHit.has(r.id)) continue;
    const cur = splitFree(r.free_of);
    const drop = cur.filter(t => !isKeeper(t));
    if (!drop.length) continue;
    outsideChanged++;
    for (const t of drop) retiredCounts.set(t, (retiredCounts.get(t) || 0) + 1);
    if (outsideChanged <= 40) {
      console.log(`   ${String(r.sku || '(no sku)').padEnd(12)} ${String(r.name || '').slice(0, 34).padEnd(34)}`);
      console.log(`      now : ${cur.join(',')}`);
      console.log(`      new : ${cur.filter(isKeeper).map(norm).join(',') || '(blank)'}`);
    }
  }
  if (outsideChanged > 40) console.log(`   … and ${outsideChanged - 40} more, not printed`);
  if (!outsideChanged) console.log('   none');

  console.log(`\n--- ${table}: summary ---`);
  console.log(`sheet rows                     : ${SHEET.length}`);
  console.log(`sheet rows already correct     : ${same}`);
  console.log(`sheet rows that would change   : ${changed}`);
  console.log(`sheet SKUs not found here      : ${missing.length}`);
  for (const m of missing) console.log(`    not found: ${m.sku}`);
  console.log(`sheet SKUs hitting >1 row      : ${multi.length}`);
  for (const m of multi) console.log(`    ${m.sheet.sku} -> ids ${m.rows.map(r => r.id).join(', ')}`);
  console.log(`other rows losing a retired flag: ${outsideChanged}`);
  for (const [t, n] of [...retiredCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`    "${t}" — on ${n} row${n === 1 ? '' : 's'} outside the sheet`);
  }

  // BLANKS. A sheet cell left empty means the product claims nothing. Read
  // literally it CLEARS the row, and that is the safe direction — a claim
  // removed is a shopper not told something true; a claim invented is a
  // shopper misled — but it is still a removal, so it is printed by name.
  const blanks = SHEET.filter(s => !s.free_of.length);
  if (blanks.length) {
    console.log(`\nSheet rows with an EMPTY "Free of" cell (${blanks.length}) — these CLEAR the row:`);
    for (const b of blanks) {
      const hit = bySku.get(key(b.sku));
      console.log(`    ${String(b.sku).padEnd(12)} now: ${hit ? hit.map(r => r.free_of || '(blank)').join(' | ') : '(sku not found)'}`);
    }
  }
}

// Every token in use, so a string nobody ever offered is visible rather than
// inferred — the details panel parks what it does not recognise in this column.
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
  for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  "${t}"${isKeeper(t) ? '' : '   <- RETIRED'}`);
  }
}

console.log('\ndone — nothing was written.');
