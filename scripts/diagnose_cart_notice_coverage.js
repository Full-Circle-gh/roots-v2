// Read-only: which add-to-cart notices are live, and which products they reach.
//
// WHY. Ash, 2026-10-03: "im adding fermented tofu and kombucha to my cart i
// dont get the warning pop up". The card can be silent for three different
// reasons and only one of them is in the code: the product is not on any
// enabled notice (data), the notice is blank (data), or this device has already
// shown that notice version once (by design, §197 — `cart_notice_seen:<id>:
// <updated_at>`). This prints the first two from the live database so the
// third can be told apart from them.
//
// It resolves coverage the way `cartNoticeIndex` in routes/retail.js does —
// named ids first, then every size in a named id's variant family (§267), first
// match wins — so "covered" here means the server stamps `cart_notice` on it.
//
//   node scripts/diagnose_cart_notice_coverage.js
'use strict';

// Opened read-only, and it proves it — same rule as every diagnose_*.js the
// "Read-only prod query" workflow runs.
const path = require('path');
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require(`${HOME}/node_modules/better-sqlite3`);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
  console.log('WARNING: this handle accepted a write. Stopping rather than reading live data.');
  process.exit(1);
} catch (e) {
  console.log('read-only proven — write rejected: ' + String(e.message).split('\n')[0] + '\n');
}

const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'cart_notices.list'").get();
let list = [];
try { list = row ? JSON.parse(row.value_json) : []; } catch (e) { console.log('cart_notices.list does not parse: ' + e.message); }
if (!Array.isArray(list)) list = [];

const byId = db.prepare('SELECT id, name_en, name_cn, variant_group_id FROM store_products WHERE id = ?');
const family = db.prepare(
  'SELECT s.id FROM store_products p JOIN store_products s ' +
  'ON s.variant_group_id = p.variant_group_id AND s.id != p.id ' +
  'WHERE p.variant_group_id IS NOT NULL AND p.id = ?');
const label = id => {
  const p = byId.get(id);
  return p ? `${String(id).padStart(5)}  ${(p.name_en || p.name_cn || '').slice(0, 50)}` : `${String(id).padStart(5)}  (no such product)`;
};
const blank = n => !['title_en', 'title_cn', 'body_en', 'body_cn']
  .some(k => typeof n[k] === 'string' && n[k].trim());

console.log(`cart_notices.list — ${list.length} notice(s)` + (row ? '' : ' (key not set)') + '\n');

// Same resolution as cartNoticeIndex: named pass, then family pass.
const cover = new Map();   // product id → { notice id, how }
const named = [];
list.forEach(n => {
  if (!n || typeof n !== 'object') return;
  const live = n.enabled !== false && !blank(n);
  const when = Number(n.updated_at) ? new Date(Number(n.updated_at)).toISOString() : String(n.updated_at || 0);
  console.log(`NOTICE ${JSON.stringify(n.id)}  enabled=${n.enabled !== false}  blank=${blank(n)}  updated_at=${n.updated_at} (${when})`);
  console.log(`  title_en: ${JSON.stringify(n.title_en || '')}`);
  console.log(`  title_cn: ${JSON.stringify(n.title_cn || '')}`);
  console.log(`  body_en:  ${JSON.stringify(n.body_en || '')}`);
  console.log(`  body_cn:  ${JSON.stringify(n.body_cn || '')}`);
  const ids = (Array.isArray(n.product_ids) ? n.product_ids : []).map(Number).filter(Number.isFinite);
  console.log(`  names ${ids.length} product(s):`);
  ids.forEach(id => console.log('   ' + label(id)));
  if (!live) { console.log('  → NOT LIVE (disabled or blank): reaches nothing.\n'); return; }
  ids.forEach(id => { named.push([id, n.id]); if (!cover.has(id)) cover.set(id, { nid: n.id, how: 'named' }); });
  console.log('');
});
named.forEach(([id, nid]) => {
  family.all(id).forEach(s => { if (!cover.has(s.id)) cover.set(s.id, { nid, how: 'size of ' + id }); });
});

// The products Ash named, found by name in both languages.
const hits = db.prepare(`
  SELECT id, name_en, name_cn, variant_group_id FROM store_products
   WHERE lower(name_en) LIKE '%kombucha%' OR lower(name_en) LIKE '%ferment%'
      OR lower(name_en) LIKE '%tofu%'     OR name_cn LIKE '%康普茶%'
      OR name_cn LIKE '%发酵%'             OR name_cn LIKE '%腐乳%'
   ORDER BY variant_group_id, id`).all();
console.log(`Products matching kombucha / ferment / tofu — ${hits.length}`);
hits.forEach(p => {
  const c = cover.get(p.id);
  console.log(`  ${String(p.id).padStart(5)}  grp=${String(p.variant_group_id ?? '-').padEnd(5)} ` +
    `${(p.name_en || p.name_cn || '').slice(0, 44).padEnd(44)}  ` +
    (c ? `notice ${JSON.stringify(c.nid)} (${c.how})` : '— NO NOTICE —'));
});
console.log('\nNothing was changed.');
