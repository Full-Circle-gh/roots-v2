#!/usr/bin/env node
/* eslint-disable no-console */
//
// Seed SYNTHETIC product reviews — staff-written social-proof reviews that
// live in `retail_synthetic_reviews`, fully decoupled from real customers and
// orders. They blend into the public rating count/avg/list on the storefront
// + mini app, but stay clearly tagged as "Seeded" in the Mini App Backend
// (Content → Reviews), where each one can be hidden or hard-removed.
//
// Distribution (per the ask):
//   • 95% of reviews are 5★, 5% are 4★  (never 1–3★)
//   • realistic, varied EN + CN comments, made-up reviewer names
//     (NEVER a real customer name)
//   • spread across a RANDOM subset of published products, 1–6 each
//   • back-dated over the last ~75 days so they don't all share a timestamp
//
// RUN THIS ON THE PROD SERVER (the local data/roots.db is a stale copy with no
// retail_* tables). From the repo root on the server:
//
//   node scripts/seed_synthetic_reviews.js              # seed (default volume)
//   node scripts/seed_synthetic_reviews.js --count 200  # cap total new reviews
//   node scripts/seed_synthetic_reviews.js --dry        # preview, write nothing
//   node scripts/seed_synthetic_reviews.js --clear      # remove ALL seeded reviews
//   node scripts/seed_synthetic_reviews.js --clear --yes # clear without prompt
//
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');

// ── tiny arg parser ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY    = hasFlag('--dry');
const CLEAR  = hasFlag('--clear');
const YES    = hasFlag('--yes');
const CAP    = parseInt(argVal('--count', '0'), 10) || 0; // 0 = no cap
const PER_MAX = Math.max(1, parseInt(argVal('--per-max', '6'), 10) || 6);

// ── deterministic-ish RNG helpers (plain Math.random, this is a CLI script) ──
// Pools, matcher and row builder are shared with the nightly top-up job.
const {
  rnd, pick, chance, shuffle, NAMES,
  categoryOf, commentFor, tagsFor, backdatedAt,
} = require('../lib/review-seeder');

// ─────────────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Bail loudly if this is the stale local copy with no retail schema.
const tableMissing = (name) => !db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
).get(name);
if (tableMissing('store_products')) {
  console.error('✗ store_products not found — this looks like a stale local DB. Run this ON the prod server.');
  process.exit(1);
}

// Ensure the synthetic table exists (mirrors database.js, so the script is
// safe to run even before the server with the new schema has restarted).
db.exec(`CREATE TABLE IF NOT EXISTS retail_synthetic_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  reviewer_name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT,
  lang TEXT,
  tags_json TEXT,
  is_visible INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_retail_synth_reviews_product ON retail_synthetic_reviews(product_id, is_visible, created_at)'); } catch {}

if (CLEAR) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM retail_synthetic_reviews').get().n;
  if (!n) { console.log('Nothing to clear — 0 seeded reviews.'); process.exit(0); }
  if (!YES && !DRY) {
    console.log(`About to DELETE all ${n} seeded reviews. Re-run with --yes to confirm (or --dry to preview).`);
    process.exit(0);
  }
  if (DRY) { console.log(`[dry] would delete ${n} seeded reviews.`); process.exit(0); }
  db.prepare('DELETE FROM retail_synthetic_reviews').run();
  console.log(`✓ Removed ${n} seeded reviews.`);
  process.exit(0);
}

// Eligible products: published + active so we only seed the live catalogue.
// (Columns guarded — fall back gracefully if a flag column is absent.)
const cols = db.prepare("PRAGMA table_info('store_products')").all().map(c => c.name);
const pubCol = cols.includes('is_published') ? 'is_published' : null;
const actCol = cols.includes('is_active') ? 'is_active' : null;
const catCol = cols.includes('category') ? 'category' : null;
const subCol = cols.includes('subcategory') ? 'subcategory' : null;
const filt = [pubCol ? `${pubCol} = 1` : null, actCol ? `${actCol} = 1` : null].filter(Boolean);
const sql = `SELECT id, name_en, name_cn${catCol ? ', ' + catCol + ' AS category' : ''}${subCol ? ', ' + subCol + ' AS subcategory' : ''}
             FROM store_products ${filt.length ? 'WHERE ' + filt.join(' AND ') : ''}`;
const products = db.prepare(sql).all();
if (!products.length) { console.error('✗ No eligible products found.'); process.exit(1); }

// Pick a RANDOM ~60% of products to receive reviews; each gets 1..PER_MAX,
// weighted toward the low end so the feed looks organic.
const chosen = shuffle(products).filter(() => chance(0.6));
const insert = db.prepare(
  `INSERT INTO retail_synthetic_reviews (product_id, reviewer_name, rating, comment, lang, tags_json, created_at)
   VALUES (@product_id, @reviewer_name, @rating, @comment, @lang, @tags_json, @created_at)`
);

let made = 0;
const sample = [];
// Build every review row first (pure generation, no DB writes), so --dry can
// preview the exact same rows that a real run would insert.
const rows = [];
for (const p of chosen) {
  if (CAP && made >= CAP) break;
  const cat = categoryOf(p);
  // weighted count: mostly 1–3, occasionally up to PER_MAX
  const roll = rnd();
  const count = roll < 0.45 ? 1 : roll < 0.75 ? 2 : roll < 0.9 ? 3 : (3 + Math.floor(rnd() * (PER_MAX - 2)));
  const usedNames = new Set();
  for (let i = 0; i < count; i++) {
    if (CAP && made >= CAP) break;
    let name = pick(NAMES);
    let guard = 0;
    while (usedNames.has(name) && guard++ < 10) name = pick(NAMES);
    usedNames.add(name);
    const rating = chance(0.95) ? 5 : 4;
    const lang = chance(0.62) ? 'cn' : 'en';
    rows.push({
      product_id: p.id,
      reviewer_name: name,
      rating,
      comment: commentFor(cat, lang, rating),
      lang,
      tags_json: tagsFor(cat),
      created_at: backdatedAt(),
      product: p.name_en || p.name_cn,
    });
    made++;
  }
}
for (const r of rows) if (sample.length < 12) sample.push(r);
if (!DRY) {
  const run = db.transaction((items) => {
    for (const r of items) {
      // strip the display-only `product` key — better-sqlite3 rejects keys
      // that don't match a named parameter.
      insert.run({
        product_id: r.product_id, reviewer_name: r.reviewer_name, rating: r.rating,
        comment: r.comment, lang: r.lang, tags_json: r.tags_json, created_at: r.created_at,
      });
    }
  });
  run(rows);
}

const total = DRY ? null : db.prepare('SELECT COUNT(*) AS n FROM retail_synthetic_reviews').get().n;
console.log('');
console.log(`${DRY ? '[dry] ' : '✓ '}${DRY ? 'would seed' : 'seeded'} ${made} reviews across ${chosen.length} products (of ${products.length} eligible).`);
console.log(`   ratings: ~95% 5★ / ~5% 4★   ·   languages: ~62% 中文 / 38% EN`);
if (!DRY) console.log(`   retail_synthetic_reviews now holds ${total} rows.`);
console.log('');
console.log('Sample:');
for (const s of sample) {
  console.log(`   ${'★'.repeat(s.rating)}${'☆'.repeat(5 - s.rating)} [${s.lang}] ${s.product ? '(' + String(s.product).slice(0, 22) + ') ' : ''}${s.comment}`);
}
console.log('');
console.log('Manage them in the Mini App Backend → Content → Reviews (each seeded row has a Remove button),');
console.log('or clear everything with:  node scripts/seed_synthetic_reviews.js --clear --yes');
