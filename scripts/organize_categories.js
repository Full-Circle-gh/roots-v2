#!/usr/bin/env node
// One-shot: organize every product into the new 2-level category scheme.
// Writes NEW columns `top_category` + `subcategory` on products; the legacy
// `category` column is left UNTOUCHED so the live shop keeps working until
// the new two-pane UI cuts over. Idempotent: re-running produces the same
// result. Reports any product whose current category we couldn't map.
//
// Usage:
//   node scripts/organize_categories.js --dry          # preview, no write
//   node scripts/organize_categories.js                # write top_category + subcategory
//   node scripts/organize_categories.js --db /path/to/roots.db
//
// Mapping keys off the product's CURRENT `category` value (robust to live
// data), with per-name overrides for the historical "Others"/blank bucket.

const path = require('path');
const Database = require('better-sqlite3');

// ── normalize so fullwidth ＆ / （） and casing don't cause misses ──────────
const norm = s => (s || '')
  .replace(/＆/g, '&').replace(/（/g, '(').replace(/）/g, ')')
  .replace(/\s+/g, ' ').trim().toLowerCase();

// existing category  →  [ TOP CATEGORY , SUBCATEGORY ]
const CAT_MAP_RAW = {
  'Nuts ＆ Seeds':                 ['Dry & Pantry', 'Nuts & Seeds'],
  'Legumes':                       ['Dry & Pantry', 'Legumes'],
  'Grains ＆ Pasta':               ['Dry & Pantry', 'Grains & Pasta'],
  'Flours':                        ['Dry & Pantry', 'Flours'],
  'Spices':                        ['Dry & Pantry', 'Spices'],
  'Oils':                          ['Dry & Pantry', 'Oils'],
  'Cacao':                         ['Dry & Pantry', 'Cacao'],
  'Granola':                       ['Dry & Pantry', 'Granola'],
  'Fruits':                        ['Dry & Pantry', 'Dried Fruits'],
  'Nut Butters':                   ['Dry & Pantry', 'Nut Butters'],
  'Jams':                          ['Dry & Pantry', 'Jams'],

  'Protein Rich':                  ['Fresh & Deli', 'Plant Protein'],
  'Dairy Alternatives':            ['Fresh & Deli', 'Plant Milks & Creams'],
  'Yogurts':                       ['Fresh & Deli', 'Yogurts'],
  'Sour Creams':                   ['Fresh & Deli', 'Sour Creams'],
  'GrassRoots Cheese Alternatives':['Fresh & Deli', 'Cheese Alternatives'],
  'Creamery':                      ['Fresh & Deli', 'Cheese Alternatives'],
  'Flavor Topping':                ['Fresh & Deli', 'Cheese Alternatives'],
  'Spreads ＆ Dips':               ['Fresh & Deli', 'Spreads & Dips'],
  'Spicy':                         ['Fresh & Deli', 'Spreads & Dips'],
  'Pickles':                       ['Fresh & Deli', 'Pickles & Olives'],
  'Bread':                         ['Fresh & Deli', 'Bread'],

  'Wraps ＆ Sandwiches':           ['Ready to Eat', 'Wraps & Sandwiches'],
  'Salads ＆ Bowls':               ['Ready to Eat', 'Salads & Bowls'],
  'Soups ＆ Stews':                ['Ready to Eat', 'Soups & Stews'],
  'Cooked Grains':                 ['Ready to Eat', 'Cooked Grains'],
  'Meals':                         ['Ready to Eat', 'Meals'],

  'Juices':                        ['Drinks', 'Juices'],
  'Kombucha':                      ['Drinks', 'Kombucha'],
  'Coffee ＆ Tea':                 ['Drinks', 'Coffee & Tea'],
  'Other Beverages':              ['Drinks', 'Coffee & Tea'],
  'Wines （Vegan Certified）':      ['Drinks', 'Wines'],
  'Beverages':                     ['Drinks', 'Plant Milk Powders'],

  'Bites':                         ['Snacks & Treats', 'Bites & Bars'],
  'Crackers':                      ['Snacks & Treats', 'Chips & Crackers'],
  'Gelato':                        ['Snacks & Treats', 'Frozen Treats'],
  'Frozen':                        ['Snacks & Treats', 'Frozen Treats'],

  'Plants Powders':                ['Wellness', 'Plant Powders'],
  'Protein Powders':               ['Wellness', 'Protein Powders'],
  'Other Supplements':             ['Wellness', 'Supplements'],

  'House Care':                    ['Home & Body', 'House Care'],
  'Cosmetics':                     ['Home & Body', 'Cosmetics'],
  'Personal Care':                 ['Home & Body', 'Personal Care'],
};

// per-product overrides (by name_en) for the historical "Others"/blank bucket
const NAME_OVERRIDE_RAW = {
  'Carob Powder （Medium Roasted）':       ['Dry & Pantry', 'Cacao'],
  'Fire Spice Cake （frozen）':            ['Snacks & Treats', 'Frozen Treats'],
  '12pc Whole Wheat Wrap（XL - 10 inch）': ['Fresh & Deli', 'Bread'],
  'Organic Soy Sauce':                    ['Dry & Pantry', 'Sauces & Condiments'],
  'Tortilla Chips':                       ['Snacks & Treats', 'Chips & Crackers'],
  'Nutritional Yeast':                    ['Dry & Pantry', 'Sauces & Condiments'],
  'Apple Pie Overnight Oats':             ['Ready to Eat', 'Breakfast'],
  'Quinoa Green Lentil Buddha Bowl':      ['Ready to Eat', 'Salads & Bowls'],
};

// products to keep OUT of the shop grid entirely (system artifact / merch)
const EXCLUDE_NAMES_RAW = ['Checkout requirements', 'The Last Batch – GoVegan Stickers'];

// fallback for products with a BLANK / unmapped category: classify by name.
// First match wins → order matters (butters before nuts, etc.). Tested only
// against products the category map couldn't place, so it never overrides a
// real category.
const KEYWORD_RULES = [
  [/(?:almond|peanut|cashew|hazelnut)\s*butter|nut butter|tahini|maple cinnamon almond/, ['Dry & Pantry', 'Nut Butters']],
  [/kombucha|booch/,                                                                       ['Drinks', 'Kombucha']],
  [/yogurt|parfait/,                                                                        ['Fresh & Deli', 'Yogurts']],
  [/energy cube|protein bite|energy ball/,                                                  ['Snacks & Treats', 'Bites & Bars']],
  [/dressing|soy sauce|nutritional yeast|sauce/,                                            ['Dry & Pantry', 'Sauces & Condiments']],
  [/almond|cashew|walnut|chia|pumpkin seed|sunflower|hemp seed|flax|seeds?|nuts?/,          ['Dry & Pantry', 'Nuts & Seeds']],
];
function keywordMatch(nName) {
  for (const [re, m] of KEYWORD_RULES) if (re.test(nName)) return m;
  return undefined;
}

// build normalized lookups
const CAT_MAP = {}; for (const k in CAT_MAP_RAW) CAT_MAP[norm(k)] = CAT_MAP_RAW[k];
const NAME_OVERRIDE = {}; for (const k in NAME_OVERRIDE_RAW) NAME_OVERRIDE[norm(k)] = NAME_OVERRIDE_RAW[k];
const EXCLUDE = new Set(EXCLUDE_NAMES_RAW.map(norm));

// ── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes('--dry') || args.includes('--dry-run');
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx >= 0 ? args[dbIdx + 1] : path.join(__dirname, '..', 'data', 'roots.db');

const db = new Database(DB_PATH);

// ── ensure columns exist (idempotent) ───────────────────────────────────────
const cols = db.prepare(`PRAGMA table_info(products)`).all().map(c => c.name);
function ensureCol(name) {
  if (!cols.includes(name)) {
    if (DRY) { console.log(`[dry] would ADD COLUMN products.${name}`); }
    else { db.prepare(`ALTER TABLE products ADD COLUMN ${name} TEXT`).run(); console.log(`+ added column products.${name}`); }
  }
}
ensureCol('top_category');
ensureCol('subcategory');

// ── assign ──────────────────────────────────────────────────────────────────
const rows = db.prepare(
  `SELECT id, name_en, category FROM products WHERE COALESCE(is_active,1)=1`
).all();

let assigned = 0, excluded = 0, unmapped = 0;
const unmappedCats = {};

function classify(p) {
  const nName = norm(p.name_en);
  if (EXCLUDE.has(nName)) return null;            // excluded → null/null
  return NAME_OVERRIDE[nName] || CAT_MAP[norm(p.category)] || keywordMatch(nName) || undefined; // undefined → unmapped
}

if (DRY) {
  // simulate counts without writing (columns may not exist yet)
  for (const p of rows) {
    const m = classify(p);
    if (m === null) { excluded++; continue; }
    if (m === undefined) { unmapped++; const key = p.category || '(blank)'; (unmappedCats[key] = unmappedCats[key] || []).push(p.name_en); continue; }
    assigned++;
  }
} else {
  const upd = db.prepare(`UPDATE products SET top_category=?, subcategory=? WHERE id=?`);
  const tx = db.transaction(() => {
    for (const p of rows) {
      const m = classify(p);
      if (m === null) { upd.run(null, null, p.id); excluded++; continue; }
      if (m === undefined) { unmapped++; const key = p.category || '(blank)'; (unmappedCats[key] = unmappedCats[key] || []).push(p.name_en); continue; }
      upd.run(m[0], m[1], p.id);
      assigned++;
    }
  });
  tx();
}

console.log(`\n${DRY ? '[DRY RUN] ' : ''}active products: ${rows.length}`);
console.log(`  assigned : ${assigned}`);
console.log(`  excluded : ${excluded}  (kept out of shop grid)`);
console.log(`  unmapped : ${unmapped}`);
if (unmapped) {
  console.log(`\n⚠  Unmapped categories found in the DB (left untouched — extend CAT_MAP):`);
  for (const c in unmappedCats) console.log(`   "${c}"  → ${unmappedCats[c].length} product(s): ${unmappedCats[c].slice(0,6).join(', ')}${unmappedCats[c].length>6?' …':''}`);
}
db.close();
