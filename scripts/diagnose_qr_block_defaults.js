#!/usr/bin/env node
/**
 * What would a CATALOGUE-WIDE default for the QR menu have to be?
 *
 * ── THE ASK ────────────────────────────────────────────────────────────────
 * Ash, 2026-09-22: "the blocks of quinoa salad that now show on the qr code
 * menu — make that the default for all products." Two halves: a RULE for the
 * future (a default set of block types the QR menu draws) and a COPY ONCE over
 * what is already there.
 *
 * ── WHY THIS IS READ BEFORE ANYTHING IS WRITTEN ────────────────────────────
 * Today the only switch is per block, per product: `hide_qr` on the block,
 * absent meaning SHOWN (lib/product-blocks-read.js, hiddenHere). There is no
 * default anywhere, so "Quinoa Salad's pattern" is not a stored thing that can
 * be copied — it has to be READ OFF that one product and then stated as a rule.
 * Getting the read wrong ships a rule that hides blocks nobody asked to hide,
 * across the whole catalogue at once.
 *
 * It also cannot assume the flags already out there were chosen. §142 records a
 * window where opening a product in the editor and saving it wrote
 * `hide_qr: true` onto whichever block was selected — the first one, unless
 * somebody clicked another. So a flag is not evidence of intent, and the copy
 * half has to tell the two apart before it clears anything.
 *
 * ── WHAT IT PRINTS ─────────────────────────────────────────────────────────
 *   1. Quinoa Salad itself: every block in order, ON or OFF for the QR menu.
 *      This is the pattern the rule would be built from.
 *   2. Every block TYPE in the catalogue: how many products carry it, how many
 *      have it switched off. A type nobody has ever switched off is a type the
 *      default can leave on without argument.
 *   3. Products whose flags CONTRADICT the Quinoa Salad pattern — what the copy
 *      would have to touch — split by the §142 accident shape (a lone flag on
 *      block #1) versus a flag that looks chosen.
 *   4. The same, narrowed to products actually listed on an active shop menu,
 *      because that is what a customer can reach today.
 *
 * NO CUSTOMER DATA. The office's own product copy only; no orders, no names,
 * no addresses.
 *
 *   node scripts/diagnose_qr_block_defaults.js
 */
'use strict';

const path = require('path');
const HOME = process.env.ROOTS_HOME || path.join(__dirname, '..');
const DB_PATH = process.env.ROOTS_DB || '/root/roots-v2/data/roots.db';
const Database = require(`${HOME}/node_modules/better-sqlite3`);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + String(e.message).split('\n')[0]);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without reading anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH);

const rule = (t) => console.log('\n' + '─'.repeat(78) + (t ? '\n' + t : ''));

const blocksOf = (raw) => {
  let b = raw;
  if (typeof b === 'string') {
    if (!b.trim()) return [];
    try { b = JSON.parse(b); } catch (e) { return null; }
  }
  return Array.isArray(b) ? b : [];
};
const off = (b) => !!(b && b.hide_qr);

// EVERY product, not only the listed ones: the rule would govern the whole
// catalogue, and a product listed next week is the reason the rule exists.
const all = db.prepare(`
  SELECT id, COALESCE(name_en, name_cn) AS name, name_en, name_cn,
         description_blocks AS blocks, updated_at
    FROM store_products
   WHERE COALESCE(is_active, 1) = 1
   ORDER BY id
`).all();

// Which of those a customer can reach today.
const listedIds = new Set(db.prepare(`
  SELECT DISTINCT sl.store_product_id AS id
    FROM shops sh
    JOIN shop_listings sl ON sl.shop_id = sh.id
   WHERE sh.is_active = 1
`).all().map(r => r.id));

console.log(`active products: ${all.length} · listed on an active shop menu: ${listedIds.size}`);

/* ── 1 · QUINOA SALAD, THE PATTERN ITSELF ──────────────────────────────── */
/* THE PATTERN COMES FROM ONE PRODUCT, AND THE FIRST VERSION OF THIS SECTION
   GOT THAT WRONG — which matters more than the bug, because a diagnostic that
   is loose about WHICH product is the reference cannot check the rule built
   from it. It matched every product whose name contains "quinoa" — #127 Mix
   Color Quinoa, #161 Ready-to-Eat Mix Quinoa, #175 Savory Quinoa Patties,
   #196 Quinoa Salad — and UNIONED their visible types. #127 carries a
   `recipe_steps` block that #196 does not, so the derived allow-list came back
   with nine types where the shipped seed has eight, and section 2b then scored
   `recipe_steps` as "kept by both readings" when the rule actually drops it.

   Ash named ONE product. The reference is #196 "Quinoa Salad". The others are
   printed for context and contribute nothing. */
rule('1 · Quinoa Salad — every block in order, as the QR menu sees it');

const REFERENCE_NAME = 'quinoa salad';
const quinoaish = all.filter(r => /quinoa/i.test(r.name_en || '') || /藜麦/.test(r.name_cn || ''));
// Exact name first; a product merely containing the words is NOT the reference.
const reference = quinoaish.find(r => String(r.name_en || '').trim().toLowerCase() === REFERENCE_NAME);

const patternTypes = new Set();   // types the REFERENCE shows
const hiddenTypes = new Set();    // types the REFERENCE has switched off

for (const q of quinoaish) {
  const isRef = reference && q.id === reference.id;
  const bs = blocksOf(q.blocks);
  console.log(`\n  #${q.id} · ${q.name}   (listed: ${listedIds.has(q.id) ? 'yes' : 'no'}, updated ${q.updated_at || '?'})` +
              (isRef ? '   ← THE REFERENCE' : '   (context only — contributes nothing)'));
  if (bs === null) { console.log('    (description_blocks is not valid JSON)'); continue; }
  if (!bs.length) { console.log('    (no description_blocks at all)'); continue; }
  bs.forEach((b, i) => {
    const t = (b && b.type) || '(untyped)';
    const hidden = off(b);
    console.log(`    ${String(i + 1).padStart(2)}. [${hidden ? 'OFF' : 'ON '}] ${t}`);
    if (!isRef) return;
    if (hidden) hiddenTypes.add(t); else patternTypes.add(t);
  });
}

if (!reference) {
  console.log(`\n  NO PRODUCT IS NAMED EXACTLY "${REFERENCE_NAME}" — the rule cannot be read off anything, ` +
              'and every number below that depends on it is meaningless.');
}
console.log('\n  pattern read off the reference product alone:');
console.log('    SHOWS: ' + ([...patternTypes].join(', ') || '(none)'));
console.log('    HIDES: ' + ([...hiddenTypes].join(', ') || '(none)'));
console.log('    NOT PRESENT (so the pattern says nothing about them): see section 2.');

/* ── 1b · DOES THE SHIPPED SEED STILL MATCH THE LIVE PRODUCT? ────────────
   The seed in lib/qr-menu-block-defaults.js was copied off this product by
   hand on 2026-09-22. The office can edit the product any day. This is the
   only place the two can be compared against the live database, so it is
   compared here rather than asserted in a unit test against a fixture. */
rule('1b · the shipped seed against the live product');
let SEED = null;
try {
  SEED = require(`${HOME}/lib/qr-menu-block-defaults`).SEED_SHOWN;
} catch (e) {
  console.log('  (could not load lib/qr-menu-block-defaults: ' + e.message + ')');
}
if (SEED) {
  const live = [...patternTypes];
  const missing = live.filter(t => SEED.indexOf(t) < 0);
  const extra = [...SEED].filter(t => live.indexOf(t) < 0);
  console.log('  shipped seed: ' + SEED.join(', '));
  console.log('  live product: ' + (live.join(', ') || '(none)'));
  if (!missing.length && !extra.length) {
    console.log('\n  MATCH — the rule still says what the product says.');
  } else {
    console.log('\n  THEY HAVE DRIFTED:');
    if (missing.length) console.log('    the product now shows, and the seed does not allow: ' + missing.join(', '));
    if (extra.length) console.log('    the seed allows, and the product no longer shows: ' + extra.join(', '));
    console.log('    Somebody edited the product after the seed was taken. Decide which is right.');
  }
}

/* ── 2 · EVERY TYPE IN THE CATALOGUE ───────────────────────────────────── */
rule('2 · every block type: how often it is carried, how often switched off');
const tally = new Map();
let unparseable = 0;
for (const r of all) {
  const bs = blocksOf(r.blocks);
  if (bs === null) { unparseable++; continue; }
  const seen = new Set();
  for (const b of bs) {
    const t = (b && b.type) || '(untyped)';
    if (!tally.has(t)) tally.set(t, { products: 0, blocks: 0, offBlocks: 0, offProducts: new Set() });
    const e = tally.get(t);
    e.blocks++;
    if (!seen.has(t)) { e.products++; seen.add(t); }
    if (off(b)) { e.offBlocks++; e.offProducts.add(r.id); }
  }
}
const pad = (s, n) => String(s).padEnd(n);
console.log('\n  ' + pad('type', 22) + pad('products', 10) + pad('blocks', 9) + pad('switched off', 14) + 'Quinoa says');
for (const [t, e] of [...tally.entries()].sort((a, b) => b[1].products - a[1].products)) {
  const says = hiddenTypes.has(t) ? 'HIDE' : (patternTypes.has(t) ? 'SHOW' : '— (not on it)');
  console.log('  ' + pad(t, 22) + pad(e.products, 10) + pad(e.blocks, 9) + pad(e.offBlocks, 14) + says);
}
if (unparseable) console.log(`\n  (${unparseable} product(s) have description_blocks that is not valid JSON)`);

/* ── 2b · §229 · THE ALLOW-LIST READING, WHICH IS THE ONE THAT SHIPPED ──── */
rule('2b · under the ALLOW-LIST: what each type loses');
console.log(`
  Ash rejected the block-list reading of this ask on 2026-09-22: it takes the
  types Quinoa Salad has switched OFF and switches those off everywhere, which
  says NOTHING about a type that product does not carry. The rule that shipped
  is the other one — the eight types Quinoa Salad DRAWS are the eight the menu
  may draw, and a type absent from that list does not draw.

  This section is the difference between the two readings, which is the only
  number that says what the correction actually cost or bought.
`);
/* MEASURED AGAINST THE SHIPPED SEED, not against a list re-derived here. The
   first version re-derived it and got a different answer (see section 1), so
   this section scored the rule against a rule nobody ships. */
const ALLOW = SEED ? [...SEED] : [...patternTypes].filter(t => !hiddenTypes.has(t));
console.log('  allow-list in force: ' + (ALLOW.join(', ') || '(none)') +
            (SEED ? '   (the shipped seed)' : '   (re-derived — lib could not be loaded)'));

let lostListed = 0, lostAll = 0;
const perType = new Map();
for (const r of all) {
  const bs = blocksOf(r.blocks);
  if (!bs || !bs.length) continue;
  for (const b of bs) {
    const t = (b && b.type) || '(untyped)';
    // What the allow-list drops that the block-list would have kept: a type
    // nobody ever switched off, simply absent from the reference product.
    if (ALLOW.indexOf(t) >= 0) continue;
    if (hiddenTypes.has(t)) continue;      // both readings drop these
    if (off(b)) continue;                  // already off by a flag
    if (!perType.has(t)) perType.set(t, { all: 0, listed: 0 });
    const e = perType.get(t);
    e.all++; lostAll++;
    if (listedIds.has(r.id)) { e.listed++; lostListed++; }
  }
}
console.log('\n  types the BLOCK-LIST would have kept drawing and the ALLOW-LIST does not:');
if (!perType.size) console.log('    (none — the two readings agree on this catalogue)');
for (const [t, e] of [...perType.entries()].sort((a, b) => b[1].all - a[1].all)) {
  console.log('    ' + pad(t, 22) + pad(e.all + ' blocks', 14) + e.listed + ' of them on a live menu');
}
console.log(`\n  total: ${lostAll} blocks, ${lostListed} of them reachable by a customer today.`);

/* ── 3 · WHAT THE COPY WOULD HAVE TO TOUCH ─────────────────────────────── */
rule('3 · products whose flags contradict the Quinoa Salad pattern');
console.log(`
  A contradiction is a block switched OFF whose type Quinoa Salad SHOWS, or a
  block left ON whose type Quinoa Salad HIDES. The first kind is what the copy
  would have to clear; the second is what the rule alone would fix.

  The §142 accident shape is a lone OFF flag on block #1. A product with a flag
  further down, or with several, was almost certainly a person — and the copy
  must not quietly overrule a person.
`);
const accident = [], deliberate = [], needHiding = [];
for (const r of all) {
  const bs = blocksOf(r.blocks);
  if (!bs || !bs.length) continue;
  const offIdx = bs.map((b, i) => (off(b) ? i : -1)).filter(i => i >= 0);
  const wrongOff = offIdx.filter(i => patternTypes.has((bs[i] && bs[i].type)));
  const wrongOn = bs.map((b, i) => (!off(b) && hiddenTypes.has(b && b.type) ? i : -1)).filter(i => i >= 0);

  if (wrongOff.length) {
    const line = `  #${r.id} · ${r.name}${listedIds.has(r.id) ? ' [LISTED]' : ''} — off: ` +
      offIdx.map(i => `${i + 1}:${(bs[i] && bs[i].type) || '?'}`).join(', ');
    if (offIdx.length === 1 && offIdx[0] === 0) accident.push(line); else deliberate.push(line);
  }
  if (wrongOn.length) {
    needHiding.push(`  #${r.id} · ${r.name}${listedIds.has(r.id) ? ' [LISTED]' : ''} — on: ` +
      wrongOn.map(i => `${i + 1}:${bs[i].type}`).join(', '));
  }
}
console.log(`\n  a) shape of the §142 accident (lone flag on block #1) — ${accident.length}`);
accident.slice(0, 60).forEach(l => console.log(l));
if (accident.length > 60) console.log(`  … and ${accident.length - 60} more`);

console.log(`\n  b) looks chosen by a person — ${deliberate.length}   ← the copy must ASK before touching these`);
deliberate.slice(0, 60).forEach(l => console.log(l));
if (deliberate.length > 60) console.log(`  … and ${deliberate.length - 60} more`);

console.log(`\n  c) carries a type Quinoa Salad HIDES, still switched on — ${needHiding.length}   ← the rule fixes these with no data change`);
needHiding.slice(0, 60).forEach(l => console.log(l));
if (needHiding.length > 60) console.log(`  … and ${needHiding.length - 60} more`);

/* ── 4 · NARROWED TO WHAT A CUSTOMER CAN REACH ─────────────────────────── */
rule('4 · listed products only — the blocks a customer can reach today');
let listedNoBlocks = 0;
const listedTally = new Map();
for (const r of all) {
  if (!listedIds.has(r.id)) continue;
  const bs = blocksOf(r.blocks);
  if (!bs || !bs.length) { listedNoBlocks++; continue; }
  for (const b of bs) {
    const t = (b && b.type) || '(untyped)';
    if (!listedTally.has(t)) listedTally.set(t, { n: 0, offN: 0 });
    const e = listedTally.get(t);
    e.n++; if (off(b)) e.offN++;
  }
}
console.log('\n  ' + pad('type', 22) + pad('blocks', 9) + pad('switched off', 14) + 'Quinoa says');
for (const [t, e] of [...listedTally.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const says = hiddenTypes.has(t) ? 'HIDE' : (patternTypes.has(t) ? 'SHOW' : '— (not on it)');
  console.log('  ' + pad(t, 22) + pad(e.n, 9) + pad(e.offN, 14) + says);
}
console.log(`\n  listed products carrying no blocks at all: ${listedNoBlocks}`);

rule('');
console.log('read complete. Nothing was written.\n');
