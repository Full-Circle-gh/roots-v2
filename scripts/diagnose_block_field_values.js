/* Which product-page fields are people typing the SAME answer into, over and over?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Ash: *"it will be easier and faster to have a pre selected options for some
 * blocks ... the tenant just click on each instead of typing it over and over
 * again for each product ... overview which blocks make sense to have that type
 * of pre list first and then we decide what will be on each list."*
 *
 * The question "which blocks" must not be answered from taste. A pick list is
 * right for a field whose values REPEAT across products and wrong for a field
 * whose values are the product's own voice — and only the catalogue knows which
 * is which. A hero paragraph must never become a dropdown; an allergen almost
 * certainly should be one.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 *   store_products.description_blocks — the office's own page copy.
 *   store_products.free_of            — for comparison: this one ALREADY has a
 *                                       pick list (PW_FREE_OF), so it shows
 *                                       what a controlled field looks like here.
 * NO CUSTOMER DATA of any kind: no orders, names, addresses or payments.
 *
 * ── WHAT IT PRINTS ─────────────────────────────────────────────────────────
 * Per block type and field: how many products fill it, how many DISTINCT
 * answers they use, the repeat rate, and the commonest answers with their
 * counts. Then a verdict:
 *
 *   PICK LIST        few answers cover most uses — typing it is wasted work
 *   LIST + FREE TEXT a common core with a real tail — offer both
 *   PROSE            nearly every answer is unique; a list would flatten the
 *                    catalogue's voice and must not be built
 *
 * It also prints CASE AND SPACING VARIANTS of the same answer, because those
 * are the argument on their own: "Nuts", "nuts" and "Tree nuts" are three
 * different strings to a filter and to a customer reading a menu.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * It changes nothing and decides nothing. A verdict here is a candidate to
 * discuss, not an instruction — a field can repeat because the catalogue is
 * young, and a rare answer can be the one that matters to the shop that uses it.
 *
 *   node scripts/diagnose_block_field_values.js
 */
'use strict';

const path = require('path');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const Database = require(`${HOME}/node_modules/better-sqlite3`);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
// Prove the handle cannot write before reading a single row.
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

// Fields whose value is the product's VOICE, never a category. Listed so the
// report says so out loud rather than letting a verdict imply otherwise.
const PROSE_FIELDS = new Set(['body_en', 'body_cn', 'text_en', 'text_cn',
                              'claim_en', 'claim_cn', 'caption_en', 'caption_cn',
                              'q_en', 'q_cn', 'a_en', 'a_cn', 'what_en', 'what_cn']);

// Walk a block and yield [fieldPath, value] for every non-empty string.
function* fieldsOf(b, prefix = '') {
  for (const k of Object.keys(b || {})) {
    if (k === 'id' || k === 'type' || k === 'hide_qr') continue;
    const v = b[k];
    if (typeof v === 'string') {
      if (v.trim()) yield [prefix + k, v.trim()];
    } else if (Array.isArray(v)) {
      for (const item of v) if (item && typeof item === 'object') yield* fieldsOf(item, prefix + k + '[].');
    } else if (v && typeof v === 'object') {
      yield* fieldsOf(v, prefix + k + '.');
    }
  }
}

const rows = db.prepare('SELECT id, free_of, description_blocks FROM store_products').all();

// type -> field -> Map(normalised -> { n, forms:Map(raw->n) })
const seen = new Map();
// type -> how many PRODUCTS carry it (so "fill rate" is per product, not per block)
const carriers = new Map();
let withBlocks = 0;

for (const r of rows) {
  const blocks = blocksOf(r.description_blocks);
  if (!blocks.length) continue;
  withBlocks++;
  const typesHere = new Set();
  for (const b of blocks) {
    const t = b && b.type;
    if (!t) continue;
    typesHere.add(t);
    if (!seen.has(t)) seen.set(t, new Map());
    const byField = seen.get(t);
    for (const [f, v] of fieldsOf(b)) {
      if (!byField.has(f)) byField.set(f, new Map());
      const norm = v.toLowerCase().replace(/\s+/g, ' ').replace(/[·,、，]\s*$/, '');
      const m = byField.get(f);
      if (!m.has(norm)) m.set(norm, { n: 0, forms: new Map() });
      const e = m.get(norm);
      e.n++;
      e.forms.set(v, (e.forms.get(v) || 0) + 1);
    }
  }
  for (const t of typesHere) carriers.set(t, (carriers.get(t) || 0) + 1);
}

console.log(`products: ${rows.length} total, ${withBlocks} with at least one block\n`);

function verdict(uses, distinct, topShare) {
  if (distinct <= 2) return 'PICK LIST        (all but fixed)';
  if (uses >= 10 && distinct <= Math.max(12, uses * 0.15)) return 'PICK LIST        (a short list covers it)';
  if (uses >= 10 && topShare >= 0.5) return 'LIST + FREE TEXT (a common core, a real tail)';
  if (uses >= 10 && distinct >= uses * 0.85) return 'PROSE            (leave it typed)';
  return 'thin evidence    (too few uses to score)';
}

// Commonest types first — the report is read top-down.
const types = [...seen.keys()].sort((a, b) => (carriers.get(b) || 0) - (carriers.get(a) || 0));

for (const t of types) {
  console.log(`\n${'═'.repeat(74)}\n${t}   —   on ${carriers.get(t)} products`);
  const byField = seen.get(t);
  const fields = [...byField.entries()].sort((a, b) => {
    const ua = [...a[1].values()].reduce((s, e) => s + e.n, 0);
    const ub = [...b[1].values()].reduce((s, e) => s + e.n, 0);
    return ub - ua;
  });
  for (const [f, m] of fields) {
    const entries = [...m.entries()].sort((a, b) => b[1].n - a[1].n);
    const uses = entries.reduce((s, [, e]) => s + e.n, 0);
    const distinct = entries.length;
    const topShare = entries.length ? entries[0][1].n / uses : 0;
    const v = PROSE_FIELDS.has(f.split('.').pop().replace(/\[\]$/, ''))
      ? 'PROSE            (the product’s own voice — never a list)'
      : verdict(uses, distinct, topShare);
    console.log(`\n  ${f}`);
    console.log(`    ${uses} filled in · ${distinct} distinct answer(s) · ${v}`);
    if (/PROSE/.test(v)) continue;
    const top = entries.slice(0, 8);
    for (const [, e] of top) {
      const forms = [...e.forms.entries()].sort((a, b) => b[1] - a[1]);
      const shown = forms[0][0].length > 46 ? forms[0][0].slice(0, 46) + '…' : forms[0][0];
      const variants = forms.length > 1
        ? `   ⚠ also typed as: ${forms.slice(1, 4).map(([s]) => JSON.stringify(s)).join(', ')}`
        : '';
      console.log(`      ${String(e.n).padStart(4)}×  ${shown}${variants}`);
    }
    if (entries.length > 8) console.log(`      …and ${entries.length - 8} more answer(s)`);
  }
}

// ── the field that already has a list, for comparison ─────────────────────
console.log(`\n${'═'.repeat(74)}\nfree_of   —   the column that ALREADY has a pick list (nuts/soy/gluten/5 spice)`);
const fo = new Map();
let foProducts = 0;
for (const r of rows) {
  const toks = String(r.free_of || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!toks.length) continue;
  foProducts++;
  for (const t of toks) fo.set(t, (fo.get(t) || 0) + 1);
}
console.log(`  ${foProducts} products declare something`);
[...fo.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) =>
  console.log(`      ${String(n).padStart(4)}×  ${k}`));
console.log('\n  Anything here outside nuts / soy / gluten / 5 spice was typed by hand');
console.log('  into the free-text escape hatch — which is what a good list looks like');
console.log('  in use, and also tells you what the list is still missing.');
