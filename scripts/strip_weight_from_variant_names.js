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
 * The duplicate most often survives in HISTORICAL order lines: a product was
 * later renamed clean (name_cn "杏仁"), but old retail_order_items captured the
 * bad name at checkout (name_cn "杏仁（小） 265g", size "265g") and still render
 * it. So this script cleans BOTH tables:
 *   - products            (against products.weight)
 *   - retail_order_items  (against retail_order_items.size)
 * finding any row whose name_en/name_cn ENDS WITH its own size value (optional
 * separators + number + optional unit like g/kg/ml) and rewriting it without.
 *
 * SAFETY:
 *   - Dry-run by default. Prints every proposed change and writes nothing.
 *   - Pass --apply to actually update rows (wrapped in a transaction).
 *   - products scan is scoped to variants (variant_group_id IS NOT NULL) by
 *     default; pass --all to include standalone products too. Order lines are
 *     always scanned in full.
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

// Column set for a table (empty if the table doesn't exist).
function colsOf(table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)); }
  catch { return new Set(); }
}

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

// Scan one table for name_en/name_cn that end with their own size value.
// `sizeCol` is the column holding the weight/size (products.weight,
// retail_order_items.size). `scopeSql` is an extra WHERE clause (no leading
// AND). Returns { changes, scanned } or null if the table/columns are missing.
function scanTable(table, sizeCol, scopeSql) {
  const c = colsOf(table);
  if (!c.has('name_en') || !c.has('name_cn') || !c.has(sizeCol)) return null;
  const where = `WHERE ${sizeCol} IS NOT NULL AND TRIM(${sizeCol}) <> ''` +
                (scopeSql ? ` AND ${scopeSql}` : '');
  const rows = db.prepare(`SELECT id, name_en, name_cn, ${sizeCol} AS sz FROM ${table} ${where}`).all();
  const changes = [];
  for (const r of rows) {
    const newEn = strip(r.name_en, r.sz);
    const newCn = strip(r.name_cn, r.sz);
    if (newEn != null || newCn != null) {
      changes.push({ id: r.id, sz: r.sz, en: { from: r.name_en, to: newEn }, cn: { from: r.name_cn, to: newCn } });
    }
  }
  return { changes, scanned: rows.length, touchUpdatedAt: c.has('updated_at') };
}

const productsHasVariant = colsOf('products').has('variant_group_id');
if (!colsOf('products').size) {
  console.error(`This DB has no products table (${dbPath}). Wrong DB?`);
  process.exit(1);
}

// Two targets:
//   products          — the master rows (scope to variants unless --all)
//   retail_order_items — historical order lines that captured a bad name at
//                        checkout (this is where the live "265g · 265g" bug
//                        usually survives even after the product was fixed).
const targets = [
  {
    table: 'products', sizeCol: 'weight',
    scope: (productsHasVariant && !all) ? 'variant_group_id IS NOT NULL' : '',
    scopeLabel: (productsHasVariant && !all) ? 'variants only' : 'all products',
  },
  { table: 'retail_order_items', sizeCol: 'size', scope: '', scopeLabel: 'all order lines' },
];

console.log(`DB: ${dbPath}\n`);

const plan = []; // { table, sizeCol, touchUpdatedAt, changes }
for (const t of targets) {
  const res = scanTable(t.table, t.sizeCol, t.scope);
  if (!res) { console.log(`${t.table}: (table/columns not present — skipped)\n`); continue; }
  console.log(`${t.table} [${t.scopeLabel}]: scanned ${res.scanned}, ${res.changes.length} would change.`);
  for (const c of res.changes) {
    console.log(`  #${c.id}  (${t.sizeCol}=${c.sz})`);
    if (c.en.to != null) console.log(`     en: "${c.en.from}"  ->  "${c.en.to}"`);
    if (c.cn.to != null) console.log(`     cn: "${c.cn.from}"  ->  "${c.cn.to}"`);
  }
  console.log('');
  if (res.changes.length) plan.push({ table: t.table, touchUpdatedAt: res.touchUpdatedAt, changes: res.changes });
}

const total = plan.reduce((n, p) => n + p.changes.length, 0);
if (!total) { console.log('Nothing to do.'); process.exit(0); }

if (!apply) {
  console.log(`Dry-run only. Re-run with --apply to write these ${total} change(s).`);
  process.exit(0);
}

db.exec('BEGIN');
try {
  for (const p of plan) {
    const ts = p.touchUpdatedAt ? ', updated_at=CURRENT_TIMESTAMP' : '';
    const updEn = db.prepare(`UPDATE ${p.table} SET name_en=?${ts} WHERE id=?`);
    const updCn = db.prepare(`UPDATE ${p.table} SET name_cn=?${ts} WHERE id=?`);
    for (const c of p.changes) {
      if (c.en.to != null) updEn.run(c.en.to, c.id);
      if (c.cn.to != null) updCn.run(c.cn.to, c.id);
    }
  }
  db.exec('COMMIT');
  console.log(`Applied ${total} change(s).`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Failed, rolled back:', e.message);
  process.exit(1);
}
