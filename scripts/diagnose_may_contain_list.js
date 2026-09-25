/* What does every product's allergen card say under "may contain traces of"?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Ash, 2026-09-23, on the Quinoa Salad sheet: the "may contain" row is the
 * shared-facility warning the law requires, and it should read the same on
 * every product — *"all products should show the same may contains traces of
 * nuts soy gluten (shared facility)"*.
 *
 * Replacing each card's own row with one fixed line would DROP any trace
 * allergen a card names beyond those three (sesame, dairy, egg ...). Before
 * that is decided, Ash asked what else is in the list. This prints it:
 * every distinct item, in each language, with how many products carry it and
 * which ones. The "contains" row is tallied the same way beside it.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 *   store_products.sku, name_en, description_blocks (the allergen_card block)
 * NO CUSTOMER DATA of any kind: no orders, names, addresses or payments.
 *
 * WHAT IT FOUND, 2026-09-23, and what was decided on it: §241 in
 * docs/tacet-consolidation-decisions.md — one shared-facility line for every
 * product, plus peanuts, sesame and seeds where a card names them.
 *
 * It changes nothing.
 *
 *   node scripts/diagnose_may_contain_list.js
 */
'use strict';

const path = require('path');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const Database = require(`${HOME}/node_modules/better-sqlite3`);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
  console.log('WARNING: this handle accepted a write. Stopping rather than reading live data.');
  process.exit(1);
} catch (e) {
  console.log('read-only proven — write rejected: ' + String(e.message).split('\n')[0] + '\n');
}

// Same separators as splitChips() in lib/product-blocks-read.js.
const split = (v) => String(v == null ? '' : v)
  .split(/[,、，;；\n]/g).map(s => s.trim()).filter(Boolean);

function card(raw) {
  let b = raw;
  if (typeof b === 'string') {
    if (!b.trim()) return null;
    try { b = JSON.parse(b); } catch { return null; }
  }
  if (!Array.isArray(b)) return null;
  return b.find(x => x && x.type === 'allergen_card') || null;
}

const cols = new Set(db.pragma('table_info(store_products)').map(c => c.name));
const name = cols.has('name_en') ? 'name_en' : 'sku';
const tenant = cols.has('tenant_id') ? 'tenant_id' : "'-'";
const rows = db.prepare(
  `SELECT id, sku, ${name} AS name, ${tenant} AS tenant, description_blocks FROM store_products`
).all();

const tally = { may_en: new Map(), may_cn: new Map(), con_en: new Map(), con_cn: new Map() };
const add = (m, item, who) => {
  const k = item.toLowerCase();
  if (!m.has(k)) m.set(k, { item, who: [] });
  m.get(k).who.push(who);
};
let withCard = 0, noCard = 0, emptyMay = 0;

for (const r of rows) {
  const c = card(r.description_blocks);
  if (!c) { noCard++; continue; }
  withCard++;
  const who = `${r.sku || '#' + r.id} ${r.name || ''} [t${r.tenant}]`.trim();
  const mayEn = split(c.may_contain_en), mayCn = split(c.may_contain_cn);
  if (!mayEn.length && !mayCn.length) emptyMay++;
  mayEn.forEach(i => add(tally.may_en, i, who));
  mayCn.forEach(i => add(tally.may_cn, i, who));
  split(c.contains_en).forEach(i => add(tally.con_en, i, who));
  split(c.contains_cn).forEach(i => add(tally.con_cn, i, who));
}

console.log(`store_products: ${rows.length} rows · ${withCard} with an allergen card · ` +
  `${noCard} without · ${emptyMay} cards with an empty "may contain" row\n`);

function print(title, m, listWho) {
  console.log('='.repeat(78) + '\n### ' + title + '\n' + '='.repeat(78));
  const list = [...m.values()].sort((a, b) => b.who.length - a.who.length);
  for (const e of list) {
    console.log(`${String(e.who.length).padStart(4)}  ${e.item}`);
    if (listWho && e.who.length <= 25) e.who.forEach(w => console.log('        - ' + w));
  }
  console.log('');
}

print('MAY CONTAIN TRACES OF — English', tally.may_en, true);
print('MAY CONTAIN TRACES OF — Chinese', tally.may_cn, true);
print('CONTAINS — English (counts only)', tally.con_en, false);
print('CONTAINS — Chinese (counts only)', tally.con_cn, false);
