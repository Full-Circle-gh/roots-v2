/* Four free-of flags, everywhere: the 2026-09-22 label sheet, and the retirement
 * of `animal products`, `dairy` and `egg`.
 *
 * ── WHAT ASH ASKED FOR ─────────────────────────────────────────────────────
 * Ash sent final_labels__v2.xlsx with a corrected "Free of" column for 112
 * products, and was asked whether the sheet should replace a product's whole
 * free_of value or only the part the sheet speaks about — the sheet names four
 * flags, the catalogue carried seven. The answer:
 *
 *   *"nuts, soy, gluten, 5 spice. - those are the one that needed. nothing
 *   else, everywhere"*
 *
 * The recommendation put to him first was the narrower one (merge, leaving the
 * other three alone), and it was not taken. Recorded here because the wider
 * read is the one being executed and the next person should see that it was a
 * decision rather than a misreading: §147 had added those three BECAUSE the
 * office kept typing them by hand, and this undoes that. The argument against
 * it then is the argument for it now — the shop is fully vegan, so all three
 * were true of every product, and a flag true of everything distinguishes
 * nothing.
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────
 * For every row of `products` and `store_products`:
 *
 *   MATCHED BY SKU to a sheet row → free_of becomes exactly what the sheet
 *     says. An empty cell in the sheet clears the row; see BLANKS below.
 *   NOT IN THE SHEET → free_of keeps only nuts / soy / gluten / 5 spice.
 *     Everything else goes: the three retired flags, and anything the details
 *     panel parked in the free-text tail over the years.
 *
 * ── THREE THINGS IT DOES ON PURPOSE, THAT LOOK LIKE OVERREACH ──────────────
 *
 * 1. IT SWEEPS THE "5spice" SPELLING, which was deliberately NOT swept before.
 *    16 products carried `5spice` next to 154 carrying `5 spice`; the panel
 *    folded the first onto the second when somebody opened the product, and
 *    scripts/test_free_of_options.js records why a sweep was refused then —
 *    Ash: "lists only, for now". "Everywhere" reverses that, and it has to:
 *    the web shop's and the mini app's LISTING filters compare the token
 *    literally against `5spice`, so the two spellings are two different
 *    claims to anything that filters. One spelling, `5 spice`, is written.
 *
 * 2. IT REWRITES THE ORDER of the flags to nuts, soy, gluten, 5 spice. The
 *    sheet's own rows vary ("gluten, 5 spice, soy"), and order changes nothing
 *    about what a product claims — but with one order, two products claiming
 *    the same four things hold the same string, and a later diff of this column
 *    shows real changes rather than reshuffles.
 *
 * 3. IT CLEARS THE THREE SHEET ROWS WITH AN EMPTY CELL — 1-320 Thai Buckwheat
 *    Noodle Salad, 1-440 Pesto 'Chicken' Wrap, 3-30 Choco-Hazel Bars. Blank
 *    could mean "free of nothing" or "not filled in yet", and the two want
 *    opposite writes. Clearing is the safe direction of the two: a claim
 *    removed is a shopper not told something true, a claim invented is a
 *    shopper with an allergy misled. They are printed by name on every run so
 *    the call can be reversed by hand if blank meant the other thing.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 * DRY RUN BY DEFAULT. Nothing is written without --apply, and oneoff.yml takes
 * a verified online backup before it passes that flag. The dry run prints every
 * row it would touch, with its before and after.
 *
 * The write is one transaction per table and touches ONE column. It is also
 * IDEMPOTENT: run it twice and the second run reports nothing to do, because
 * the rule is a function of the sheet and the four keepers, not of the current
 * value.
 *
 * ── WHY THE SHEET IS INLINE ────────────────────────────────────────────────
 * oneoff.yml copies exactly ONE file to the box — the script named in the
 * dispatch. A sibling .json is not staged, and the first read-only run died on
 * precisely that. scripts/test_free_of_sheet_table.js holds this inlined copy
 * equal to scripts/free_of_sheet_2026-09-22.json.
 *
 *   node scripts/oneoff_free_of_from_sheet.js            # dry run
 *   node scripts/oneoff_free_of_from_sheet.js --apply    # writes
 */
'use strict';

const path = require('path');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const Database = require(`${HOME}/node_modules/better-sqlite3`);

const APPLY = process.argv.includes('--apply');

// ── THE SHEET ──────────────────────────────────────────────────────────────
// final_labels__v2.xlsx, sheet "final", columns A (SKU) and H (Free of), as
// sent 2026-09-22. `sku|comma,separated,flags`; an empty right-hand side is an
// empty cell in the sheet and CLEARS the row — see point 3 above.
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

// ── THE RULE ───────────────────────────────────────────────────────────────

// The four that exist. This order is the order written — see point 2 above.
const KEEP = ['nuts', 'soy', 'gluten', '5 spice'];

// One claim, several spellings. The store editor writes "5 spice"; "5spice"
// and "5-spice" are the same thing and fold onto it.
function norm(t) {
  const s = String(t || '').trim().toLowerCase();
  return /^5[\s-]*spice$/.test(s) ? '5 spice' : s;
}
const splitFree = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
// Canonical order, no duplicates, only the four.
const canon = (toks) => KEEP.filter(k => toks.some(t => norm(t) === k)).join(',');

// A printed SKU and a stored SKU differ by case, spacing and the full-width
// brackets the office's keyboard produces — the sheet has "S(1-30）" with one
// of each. Fold all three or a row that exists reads as missing, and a missing
// row is a label that silently stays wrong.
const key = (s) => String(s || '').trim().toLowerCase()
  .replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '');

const SHEET = new Map();
for (const line of SHEET_ROWS) {
  const [sku, flags] = line.split('|');
  SHEET.set(key(sku), { sku, want: canon(splitFree(flags)) });
}
if (SHEET.size !== SHEET_ROWS.length) {
  console.error(`REFUSING TO RUN: ${SHEET_ROWS.length} sheet rows collapse to ${SHEET.size} SKUs.`);
  console.error('Two rows share a SKU once case and brackets are folded, so which one wins is luck.');
  process.exit(1);
}

const db = new Database(DB_PATH, { fileMustExist: true });

console.log(APPLY ? '*** APPLY — this run WRITES ***\n' : 'DRY RUN — nothing will be written\n');

function tables() {
  const have = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
  return ['products', 'store_products'].filter(have);
}
const found = tables();
if (!found.length) { console.error('REFUSING TO RUN: neither products nor store_products exists.'); process.exit(1); }

const sheetSeen = new Set();   // sheet SKUs that matched SOMETHING, in any table
let grandTotal = 0;

for (const table of found) {
  const cols = new Set(db.pragma(`table_info(${table})`).map(c => c.name));
  if (!cols.has('sku') || !cols.has('free_of')) {
    console.log(`### ${table}: no sku/free_of column — skipped\n`);
    continue;
  }
  const nameCol = cols.has('name_en') ? 'name_en' : 'sku';
  const rows = db.prepare(`SELECT id, sku, ${nameCol} AS name, free_of FROM ${table}`).all();

  const plan = [];
  for (const r of rows) {
    const cur = String(r.free_of == null ? '' : r.free_of);
    const hit = r.sku ? SHEET.get(key(r.sku)) : null;
    if (hit) sheetSeen.add(key(hit.sku));
    // A row the sheet names takes the sheet's answer whole. A row it does not
    // name keeps only the four it already claims — the sheet says nothing about
    // that product, so nothing is invented for it.
    const want = hit ? hit.want : canon(splitFree(cur));
    // NULL and '' are the same emptiness to every reader of this column; do not
    // churn a row from one to the other and call it a change.
    if (cur === want || (!cur && !want)) continue;
    plan.push({ id: r.id, sku: r.sku, name: r.name, from: cur, to: want, bySheet: !!hit });
  }

  console.log(`${'='.repeat(78)}\n### ${table} — ${rows.length} rows, ${plan.length} to change\n${'='.repeat(78)}`);
  for (const p of plan) {
    console.log(` ${p.bySheet ? 'S' : ' '} ${String(p.sku || '(no sku)').padEnd(12)} ${String(p.name || '').slice(0, 36).padEnd(36)}`);
    console.log(`      from: ${p.from || '(blank)'}`);
    console.log(`      to  : ${p.to || '(blank)'}`);
  }
  console.log(`\n   S = named by the sheet (${plan.filter(p => p.bySheet).length}); ` +
              `blank = not in the sheet, losing a retired flag or a stray value (${plan.filter(p => !p.bySheet).length})`);

  if (APPLY && plan.length) {
    // '' rather than NULL: the column is read with `(free_of || '')` everywhere,
    // so the two are identical to every reader, and '' is what the editor saves.
    const upd = db.prepare(`UPDATE ${table} SET free_of = ? WHERE id = ?`);
    const run = db.transaction((items) => { for (const p of items) upd.run(p.to, p.id); });
    run(plan);
    console.log(`\n   WROTE ${plan.length} row${plan.length === 1 ? '' : 's'} in ${table}.`);
  }
  grandTotal += plan.length;
  console.log('');
}

// A sheet SKU that matched nothing is the failure mode that hides: the run goes
// green, the label stays wrong, and nobody finds out until a shopper asks.
const misses = [...SHEET.values()].filter(s => !sheetSeen.has(key(s.sku)));
if (misses.length) {
  console.log(`!! ${misses.length} of ${SHEET.size} sheet SKUs matched NO row in any table:`);
  for (const m of misses) console.log(`     ${m.sku}   (would have been: ${m.want || 'blank'})`);
  console.log('   These labels are unchanged. Either the SKU is written differently in the');
  console.log('   catalogue, or the product is not in it.');
} else {
  console.log(`All ${SHEET.size} sheet SKUs matched at least one row.`);
}

// Blanks are announced on every run, applied or not, so the judgement stays visible.
const blanks = [...SHEET.values()].filter(s => !s.want);
if (blanks.length) {
  console.log(`\nSheet rows with an EMPTY "Free of" cell (${blanks.length}) — these CLEAR the row:`);
  for (const b of blanks) console.log(`     ${b.sku}`);
  console.log('   If blank meant "not filled in yet" rather than "free of nothing",');
  console.log('   these three are the ones to put back by hand.');
}

console.log(`\n${APPLY ? 'WROTE' : 'WOULD WRITE'} ${grandTotal} row${grandTotal === 1 ? '' : 's'} in total.`);
if (!APPLY) console.log('DRY RUN — nothing was written. Re-run with apply=true once this reads right.');
