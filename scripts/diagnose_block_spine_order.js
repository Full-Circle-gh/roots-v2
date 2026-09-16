/* Do product pages already agree on the order of their blocks?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Ash chose Option A for the product editor: the editor stops being a list of
 * blocks you assemble and becomes a fixed spine of named sections, always in
 * the order a customer reads them. That design has exactly one dangerous
 * consequence, and it is not visible in any mockup:
 *
 *   If the editor renders a fixed order, then opening a product and saving it
 *   REORDERS the customer's page — silently, with no edit made.
 *
 * Whether that matters is a question about the data, not about the design. If
 * the 260 live products already carry their blocks in one order, a canonical
 * spine is a no-op on save and can be adopted outright. If they carry many
 * orders, the editor must render the spine while PRESERVING each product's
 * stored order on save, and reordering has to become something the operator
 * asks for.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 *   store_products.description_blocks — the office's own layout choices.
 * NO CUSTOMER DATA of any kind: no orders, names, addresses or payments.
 *
 * ── WHAT IT PRINTS ─────────────────────────────────────────────────────────
 *   1. How many products carry each block type, as a share of products that
 *      have any blocks at all. This is the "% of your products say this" line
 *      the empty rows in the new editor are meant to show.
 *   2. The distinct block orders actually in use, commonest first, with how
 *      many products carry each.
 *   3. Against the commonest order, how many products are already a
 *      subsequence of it — i.e. how many a canonical spine would NOT disturb.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * It changes nothing and decides nothing. It reports the spread so the
 * reorder-on-save question can be settled on evidence.
 *
 *   node scripts/diagnose_block_spine_order.js
 */
'use strict';

const path = require('path');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const Database = require(`${HOME}/node_modules/better-sqlite3`);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
// Prove the handle cannot write before reading a single row. A diagnostic that
// merely INTENDS to be read-only is one somebody later adds a write to.
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
  console.log('WARNING: this handle accepted a write. Stopping rather than reading live data.');
  process.exit(1);
} catch (e) {
  console.log('read-only proven — write rejected: ' + String(e.message).split('\n')[0] + '\n');
}

function blocksOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

const rows = db.prepare('SELECT id, name_en, description_blocks FROM store_products').all();
const withBlocks = [];
for (const r of rows) {
  const types = blocksOf(r.description_blocks).map(b => b && b.type).filter(Boolean);
  if (types.length) withBlocks.push({ id: r.id, name: r.name_en || '', types });
}

console.log(`products: ${rows.length} total, ${withBlocks.length} with at least one block\n`);
if (!withBlocks.length) { console.log('nothing to report.'); process.exit(0); }

// ── 1. how common is each type ────────────────────────────────────────────
const carry = new Map();
for (const p of withBlocks) {
  for (const t of new Set(p.types)) carry.set(t, (carry.get(t) || 0) + 1);
}
console.log('── how many products carry each block type ──');
[...carry.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
  console.log(`  ${String(Math.round(n / withBlocks.length * 100)).padStart(3)}%  ${String(n).padStart(4)}  ${t}`);
});

// ── 2. the distinct orders in use ─────────────────────────────────────────
// Duplicates of a type are collapsed to first appearance: the question is the
// SEQUENCE of sections, not how many of each.
function spineOf(types) {
  const seen = new Set(), out = [];
  for (const t of types) if (!seen.has(t)) { seen.add(t); out.push(t); }
  return out;
}
const orders = new Map();
for (const p of withBlocks) {
  const k = spineOf(p.types).join(' > ');
  if (!orders.has(k)) orders.set(k, []);
  orders.get(k).push(p.name || p.id);
}
const ranked = [...orders.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`\n── distinct block orders in use: ${ranked.length} ──`);
ranked.slice(0, 12).forEach(([k, ps], i) => {
  console.log(`\n  #${i + 1}  ${ps.length} product(s)`);
  console.log(`      ${k}`);
  if (ps.length <= 4) console.log(`      e.g. ${ps.slice(0, 4).join(', ')}`);
});
if (ranked.length > 12) console.log(`\n  …and ${ranked.length - 12} more order(s) carried by 1-2 products each.`);

// ── 3. would a canonical spine disturb anybody? ───────────────────────────
// A product is undisturbed if its own order is a SUBSEQUENCE of the canonical
// one: every section it has appears in the same relative order.
const canonical = ranked[0][0].split(' > ');
function isSubsequence(small, big) {
  let i = 0;
  for (const t of small) {
    const at = big.indexOf(t, i);
    if (at < 0) return false;
    i = at + 1;
  }
  return true;
}
let ok = 0; const disturbed = [];
for (const p of withBlocks) {
  if (isSubsequence(spineOf(p.types), canonical)) ok++;
  else disturbed.push(p.name || p.id);
}
console.log(`\n── against the commonest order ──`);
console.log(`  canonical: ${canonical.join(' > ')}`);
console.log(`  ${ok} of ${withBlocks.length} products (${Math.round(ok / withBlocks.length * 100)}%) already sit inside it — a canonical spine would not move their sections.`);
if (disturbed.length) {
  console.log(`  ${disturbed.length} would be REORDERED by a save:`);
  disturbed.slice(0, 25).forEach(n => console.log(`      ${n}`));
  if (disturbed.length > 25) console.log(`      …and ${disturbed.length - 25} more`);
}
