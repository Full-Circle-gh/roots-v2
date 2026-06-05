#!/usr/bin/env node
/*
 * strip_weight_from_variant_names.js
 * ----------------------------------
 * Fixes the "265g · 265g" duplication in order manifests / mini-app cards.
 *
 * Root cause: some variant products have the weight baked into their
 * name_en / name_cn (e.g. name_cn = "杏仁（小） 265g") while the `weight`
 * column ALSO holds "265g". Views that render `name · weight` then show the
 * size twice. The weight is carried separately, so it's safe to strip the
 * trailing weight out of the name.
 *
 * This script finds every product whose name_en or name_cn ENDS WITH its own
 * `weight` value (optionally preceded by separators like space, ·, -, /),
 * and rewrites the name without it.
 *
 * SAFETY:
 *   - Dry-run by default. Prints every proposed change and writes nothing.
 *   - Pass --apply to actually update rows (wrapped in a transaction).
 *   - Scoped to variant products (variant_group_id IS NOT NULL) by default.
 *     Pass --all to include standalone products too.
 *
 * Usage:
 *   node scripts/strip_weight_from_variant_names.js [dbPath]            # dry-run, variants
 *   node scripts/strip_weight_from_variant_names.js [dbPath] --all      # dry-run, all products
 *   node scripts/strip_weight_from_variant_names.js [dbPath] --apply    # write changes
 */

const args   = process.argv.slice(2);
const apply  = args.includes('--apply');
const all    = args.includes('--all');
const dbPath = args.find(a => !a.startsWith('--')) || 'data/roots.db';

// Open the DB. Prefer better-sqlite3 (what the app ships, works on Node 20);
// fall back to node:sqlite for newer runtimes that have it built in. Both
// expose the same prepare().all()/.get()/.run() + exec() surface used below.
let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(dbPath);
} catch (e1) {
  try {
    const sqlite = require('node:sqlite');
    db = new sqlite.DatabaseSync(dbPath);
  } catch (e2) {
    console.error('No SQLite driver available (tried better-sqlite3 and node:sqlite).');
    console.error('Run this from the project root so better-sqlite3 resolves.');
    process.exit(1);
  }
}

// Be tolerant of schema differences between tenant DBs.
const cols = new Set(db.prepare('PRAGMA table_info(products)').all().map(c => c.name));
const hasVariant = cols.has('variant_group_id');
if (!hasVariant && !all) {
  console.error(
    `This DB's products table has no variant_group_id column (${dbPath}).\n` +
    `It looks like the wrong/old schema. Re-run against the tenant DB, or pass --all to scan every product.`
  );
  process.exit(1);
}

const where = (hasVariant && !all)
  ? `WHERE variant_group_id IS NOT NULL AND weight IS NOT NULL AND TRIM(weight) <> ''`
  : `WHERE weight IS NOT NULL AND TRIM(weight) <> ''`;

const rows = db.prepare(
  `SELECT id, name_en, name_cn, weight FROM products ${where}`
).all();

// Escape a string for use inside a RegExp.
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Optional unit that may trail the weight in a name. The `weight` column is
// usually a bare number (265) while the name carries the unit ("265g"), so we
// match the number plus an optional unit suffix.
const UNIT = '(?:kg|g|ml|l|克|千克|毫升|升|斤|两)?';

// Strip a trailing occurrence of `weight` from `name`, including any
// separators / whitespace before it and an optional unit suffix after it.
// `weight` may be a number (265) or a string ("265g"). Returns the cleaned
// name, or null if nothing matched.
function strip(name, weight) {
  if (name == null || weight == null) return null;
  const raw = String(weight).trim();
  if (!raw) return null;
  // Extract the numeric core ("265" from 265 or "265g"); fall back to the raw
  // string for non-numeric weights (e.g. a size label like "L").
  const m = raw.match(/^([\d]+(?:\.[\d]+)?)\s*([a-zA-Z一-鿿]*)$/);
  const core = m ? m[1] : raw;
  if (!core) return null;
  // trailing: [separators] + number + [optional unit] + [optional trailing brackets/space]
  const re = new RegExp('[\\s·•・\\-–—/，,]*(?<![\\d.])' + esc(core) + '\\s*' + UNIT + '[\\s）)\\]]*$', 'i');
  if (!re.test(name)) return null;
  const cleaned = name.replace(re, '').trim();
  // Don't blank out a name entirely (e.g. a variant literally named "265g").
  if (!cleaned) return null;
  return cleaned === name ? null : cleaned;
}

const changes = [];
for (const r of rows) {
  const newEn = strip(r.name_en, r.weight);
  const newCn = strip(r.name_cn, r.weight);
  if (newEn != null || newCn != null) {
    changes.push({
      id: r.id, weight: r.weight,
      en: { from: r.name_en, to: newEn },
      cn: { from: r.name_cn, to: newCn },
    });
  }
}

console.log(`DB: ${dbPath}`);
console.log(`Scope: ${(hasVariant && !all) ? 'variants only' : 'all products'}`);
console.log(`Scanned ${rows.length} product(s); ${changes.length} would change.\n`);

for (const c of changes) {
  console.log(`#${c.id}  (weight=${c.weight})`);
  if (c.en.to != null) console.log(`   en: "${c.en.from}"  ->  "${c.en.to}"`);
  if (c.cn.to != null) console.log(`   cn: "${c.cn.from}"  ->  "${c.cn.to}"`);
}

if (!changes.length) {
  console.log('\nNothing to do.');
  process.exit(0);
}

if (!apply) {
  console.log(`\nDry-run only. Re-run with --apply to write these ${changes.length} change(s).`);
  process.exit(0);
}

const updEn = db.prepare('UPDATE products SET name_en=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
const updCn = db.prepare('UPDATE products SET name_cn=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
db.exec('BEGIN');
try {
  for (const c of changes) {
    if (c.en.to != null) updEn.run(c.en.to, c.id);
    if (c.cn.to != null) updCn.run(c.cn.to, c.id);
  }
  db.exec('COMMIT');
  console.log(`\nApplied ${changes.length} change(s).`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('\nFailed, rolled back:', e.message);
  process.exit(1);
}
