/* The spec strip, and the hero intro, in enough detail to design a pick list.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * scripts/diagnose_block_field_values.js answered "which blocks deserve a
 * pre-selected list" across the whole catalogue, but its output is long and
 * the two commonest blocks — spec_strip (93% of products) and hero_intro
 * (99%) — scrolled off the top of the Actions log before anyone read them.
 * Ash: *"spec first"*.
 *
 * So this is the same question asked of two block types only, and asked in the
 * shape that actually designs a list rather than merely justifying one:
 *
 *   A SPEC STRIP CELL IS A LABEL AND A VALUE. The label ("Origin") is the
 *   pick-list candidate. The value ("Shanghai") may be one too, but only
 *   WITHIN a label — "Shanghai" is a sensible option under Origin and nonsense
 *   under Net Wt. So values are reported GROUPED BY THE LABEL THEY SIT UNDER,
 *   which is the table you would copy a list out of.
 *
 * It also reports labels BY CELL POSITION, because the editor seeds three
 * cells (Type / Net Wt / Origin) and the interesting question is how far the
 * catalogue has drifted from that seed.
 *
 * ── WHAT IT READS ──────────────────────────────────────────────────────────
 *   store_products.description_blocks — the office's own page copy.
 * NO CUSTOMER DATA of any kind: no orders, names, addresses or payments.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * It changes nothing and decides nothing. A value that appears once may be the
 * only honest answer for that product; a list is an offer, not a constraint.
 *
 *   node scripts/diagnose_spec_strip_labels.js
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

function blocksOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}
const t = (s) => String(s == null ? '' : s).trim();
// Normalise for COUNTING only; the report always prints the real forms, because
// the forms are the finding: "Cool & Dry" and "Cool & dry" are one answer
// somebody typed two ways, and a list is what stops that.
const norm = (s) => t(s).toLowerCase().replace(/\s+/g, ' ');

function tally() {
  const m = new Map();
  return {
    add(raw) {
      const k = norm(raw);
      if (!k) return;
      if (!m.has(k)) m.set(k, { n: 0, forms: new Map() });
      const e = m.get(k);
      e.n++;
      e.forms.set(t(raw), (e.forms.get(t(raw)) || 0) + 1);
    },
    get total() { return [...m.values()].reduce((s, e) => s + e.n, 0); },
    get size() { return m.size; },
    top(limit) {
      return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, limit);
    },
  };
}
function printTally(tl, limit, indent) {
  const pad = ' '.repeat(indent);
  for (const [, e] of tl.top(limit)) {
    const forms = [...e.forms.entries()].sort((a, b) => b[1] - a[1]);
    const shown = forms[0][0].length > 52 ? forms[0][0].slice(0, 52) + '…' : forms[0][0];
    const variants = forms.length > 1
      ? `   ⚠ also typed: ${forms.slice(1, 4).map(([s]) => JSON.stringify(s)).join(', ')}`
      : '';
    console.log(`${pad}${String(e.n).padStart(4)}×  ${shown}${variants}`);
  }
  if (tl.size > limit) console.log(`${pad}      …and ${tl.size - limit} more`);
}

const rows = db.prepare('SELECT id, description_blocks FROM store_products').all();

// ── SPEC STRIP ────────────────────────────────────────────────────────────
const cellCounts = new Map();          // how many cells a strip has
const labelEn = tally(), labelCn = tally();
const byPosition = [];                 // position -> tally of EN labels
const valuesUnder = new Map();         // normalised EN label -> { en, cn, shownAs }
let specProducts = 0, specBlocks = 0;

// ── HERO INTRO ────────────────────────────────────────────────────────────
const kickerEn = tally(), kickerCn = tally(), hiEn = tally(), hiCn = tally();
const bodyEn = tally();
let heroProducts = 0;

for (const r of rows) {
  const blocks = blocksOf(r.description_blocks);
  let sawSpec = false, sawHero = false;
  for (const b of blocks) {
    if (b && b.type === 'spec_strip') {
      sawSpec = true; specBlocks++;
      const cells = Array.isArray(b.cells) ? b.cells : [];
      cellCounts.set(cells.length, (cellCounts.get(cells.length) || 0) + 1);
      cells.forEach((c, i) => {
        const ken = t(c && c.k_en), kcn = t(c && c.k_cn);
        labelEn.add(ken); labelCn.add(kcn);
        if (!byPosition[i]) byPosition[i] = tally();
        byPosition[i].add(ken || kcn);
        const key = norm(ken) || norm(kcn);
        if (!key) return;
        if (!valuesUnder.has(key)) valuesUnder.set(key, { shownAs: ken || kcn, en: tally(), cn: tally(), n: 0 });
        const slot = valuesUnder.get(key);
        slot.n++;
        slot.en.add(c && c.v_en);
        slot.cn.add(c && c.v_cn);
      });
    }
    if (b && b.type === 'hero_intro') {
      sawHero = true;
      kickerEn.add(b.kicker_en); kickerCn.add(b.kicker_cn);
      hiEn.add(b.highlight_en);  hiCn.add(b.highlight_cn);
      bodyEn.add(b.body_en);
    }
  }
  if (sawSpec) specProducts++;
  if (sawHero) heroProducts++;
}

console.log(`${'═'.repeat(74)}\nSPEC STRIP — on ${specProducts} products (${specBlocks} strips)\n`);

console.log('── how many cells a strip carries ──');
[...cellCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, c]) =>
  console.log(`  ${String(c).padStart(4)} strip(s) with ${n} cell(s)`));
console.log('  (the editor seeds three: Type / Net Wt / Origin)');

console.log(`\n── the LABELS, EN — ${labelEn.total} cells, ${labelEn.size} distinct ──`);
printTally(labelEn, 25, '    ');
console.log(`\n── the LABELS, 中文 — ${labelCn.total} cells, ${labelCn.size} distinct ──`);
printTally(labelCn, 25, '    ');

console.log('\n── labels BY CELL POSITION — has the catalogue drifted from the seed? ──');
byPosition.forEach((tl, i) => {
  console.log(`\n  cell ${i + 1}  (${tl.total} strips, ${tl.size} distinct label(s))`);
  printTally(tl, 8, '      ');
});

console.log(`\n\n── the VALUES, grouped by the label they sit under ──`);
console.log('   This is the table a list is copied out of: "Shanghai" belongs');
console.log('   under Origin and nowhere else.\n');
[...valuesUnder.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10).forEach(([, slot]) => {
  console.log(`  ${'─'.repeat(70)}`);
  console.log(`  ${slot.shownAs}   —   ${slot.n} cell(s)`);
  console.log(`    EN values: ${slot.en.total} filled, ${slot.en.size} distinct`);
  printTally(slot.en, 12, '      ');
  console.log(`    中文 values: ${slot.cn.total} filled, ${slot.cn.size} distinct`);
  printTally(slot.cn, 12, '      ');
});

console.log(`\n\n${'═'.repeat(74)}\nHERO INTRO — on ${heroProducts} products\n`);
console.log(`── kicker, EN — ${kickerEn.total} filled, ${kickerEn.size} distinct ──`);
printTally(kickerEn, 20, '    ');
console.log(`\n── kicker, 中文 — ${kickerCn.total} filled, ${kickerCn.size} distinct ──`);
printTally(kickerCn, 20, '    ');
console.log(`\n── highlight phrase, EN — ${hiEn.total} filled, ${hiEn.size} distinct ──`);
printTally(hiEn, 12, '    ');
console.log(`\n── body, EN — ${bodyEn.total} filled, ${bodyEn.size} distinct ──`);
console.log('    (printed as a count only: the body is the product’s own voice');
console.log('     and must never become a list — this line is here to show why)');
