/* Which products would show NO allergen card, and what kind of page are they?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * §241 put one shared-facility trace line — Nuts, Soy, Gluten (shared
 * facility) — on every allergen card. The line is required on every product,
 * and 174 of 372 store products carry no card, so they show no line at all.
 * Ash, 2026-09-23: "go 1" — close that gap.
 *
 * The pages draw a card from the product's description_blocks, and two of
 * the three surfaces only draw blocks at all when use_block_design is on. So
 * how the gap is closed depends on which of these shapes the 174 are:
 *
 *   A. block design on, a card with content        → already shows (§241)
 *   B. block design on, card EMPTY (editor skeleton) → shows nothing today
 *   C. block design on, no card block at all         → shows nothing today
 *   D. block design OFF                              → plain description page
 *
 * each split by is_active, because an inactive product is on no page.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 *   store_products: id, sku, name_en, is_active, use_block_design,
 *   description_blocks, free_of
 * NO CUSTOMER DATA of any kind.
 *
 * It changes nothing.
 *
 *   node scripts/diagnose_allergen_card_coverage.js
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

const cols = new Set(db.pragma('table_info(store_products)').map(c => c.name));
const col = (c, dflt) => (cols.has(c) ? c : `${dflt} AS ${c}`);
const rows = db.prepare(`SELECT id, sku, ${col('name_en', "''")}, ${col('is_active', 1)},
  ${col('use_block_design', 0)}, description_blocks, ${col('free_of', "''")} FROM store_products`).all();
console.log(`columns present: is_active=${cols.has('is_active')} use_block_design=${cols.has('use_block_design')}\n`);

function blocks(raw) {
  let b = raw;
  if (typeof b === 'string') { if (!b.trim()) return []; try { b = JSON.parse(b); } catch { return []; } }
  return Array.isArray(b) ? b : [];
}
const filled = (c) => ['contains_en', 'contains_cn', 'may_contain_en', 'may_contain_cn']
  .some(k => String(c[k] == null ? '' : c[k]).trim());

const groups = {};
for (const r of rows) {
  const bl = blocks(r.description_blocks);
  const cards = bl.filter(b => b && b.type === 'allergen_card');
  let shape;
  if (!r.use_block_design) shape = 'D  block design OFF';
  else if (cards.some(filled)) shape = 'A  block design on, card with content';
  else if (cards.length) shape = 'B  block design on, card EMPTY';
  else shape = 'C  block design on, no card block';
  if (!r.use_block_design && cards.some(filled)) shape = 'D* block design OFF but a filled card exists';
  const key = `${shape} · ${r.is_active ? 'active' : 'INACTIVE'}`;
  (groups[key] = groups[key] || []).push(r);
}

for (const k of Object.keys(groups).sort()) {
  const g = groups[k];
  console.log(`${String(g.length).padStart(4)}  ${k}`);
  if (k.startsWith('A') || !/ active$/.test(k)) continue;
  for (const r of g.slice(0, 60)) {
    const nb = blocks(r.description_blocks).length;
    console.log(`        - ${r.sku || '#' + r.id} ${r.name_en || ''} · ${nb} blocks · free_of="${r.free_of || ''}"`);
  }
  if (g.length > 60) console.log(`        … ${g.length - 60} more`);
}
