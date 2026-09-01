#!/usr/bin/env node
//
// test_material_arrived_tooltip.js — red-proof for the tooltip that says what a
// MATERIAL line's Arrived box actually does.
//
// THE DEFECT THIS COVERS. On the desktop receiving screen, a material line's
// Arrived box drives Finance and never stock: applyReceivedToStock() skips any
// line carrying an ingredient_id, while postRetailPOExpenses() sums
// COALESCE(qty_received, qty) with no kind branch. So the box is the ONLY way to
// record a short material delivery — blank on a 20-unit line with 15 delivered
// posts 160.00 instead of 120.00 — and the In-stock cell beside it shows an em
// dash for ever, because stock_applied_qty is never written for that line. The
// two together read as "the number you typed did nothing", which is how the box
// came to be proposed for deletion, tried and reverted 2026-08-27. The reason
// lived only in a code comment, where no operator hovering over the row sees it.
//
// TWO KINDS OF ASSERTION, LABELLED, per the house rule in
// test_purchasing_line_supplier.js — a suite that lets both read as proof is a
// suite that looks like evidence and is not:
//
//   BEHAVIOURAL  receiveRow() LIFTED FROM THE SHIPPED FILE and executed, with
//                its collaborators stubbed. What these assertions run is the
//                function that ships, and the string they read is the string in
//                the product — not a copy pasted into this file that could drift
//                from it without either one going red.
//   SOURCE       string checks over public/retail-admin/16-purchasing.js and
//                docs/tacet-delivery-vocabulary.md. They prove what is WRITTEN —
//                that the pair is locked in the doc and matches the code
//                verbatim — not what anything renders.
//
// EVERY SOURCE ANCHOR IS MUTATION-TESTED. A source check that cannot go red is a
// PASS line with nothing behind it.
//
// USAGE   node scripts/test_material_arrived_tooltip.js
// EXIT    0 every assertion held · 1 an assertion failed · 2 could not run

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UI_PATH = path.join(ROOT, 'public', 'retail-admin', '16-purchasing.js');
const DOC_PATH = path.join(ROOT, 'docs', 'tacet-delivery-vocabulary.md');
const UI_SRC = fs.readFileSync(UI_PATH, 'utf8');
const DOC_SRC = fs.readFileSync(DOC_PATH, 'utf8');

let fails = 0;
const ok = (kind, name, cond, got) => {
  if (cond) console.log(`  PASS  [${kind}] ${name}`);
  else { fails++; console.log(`  FAIL  [${kind}] ${name}${got === undefined ? '' : ' — got ' + JSON.stringify(got)}`); }
};
const die = (msg) => { console.error(`\nCANNOT RUN: ${msg}`); process.exit(2); };

// ── Lift receiveRow out of the shipped file ────────────────────────────────
// The file is a browser IIFE, so it cannot be require()d. receiveRow sits at one
// level of indentation inside it and ends at the first `\n  }` after its opening,
// which is checked below rather than assumed — if the shape ever changes, this
// exits 2 (cannot run) instead of silently testing nothing.
function liftReceiveRow() {
  const start = UI_SRC.indexOf('function receiveRow(');
  if (start === -1) die('receiveRow not found in 16-purchasing.js');
  const end = UI_SRC.indexOf('\n  }', start);
  if (end === -1) die('could not find the end of receiveRow');
  const src = UI_SRC.slice(start, end + 4);
  if (!/return `<tr data-line=/.test(src)) die('lifted receiveRow does not look like the row renderer');
  // Collaborators the row calls. Each is the narrowest stub that still lets the
  // real template run; none of them can manufacture a data-tt.
  const make = (lang) => {
    const T = (en, cn) => (lang === 'cn' ? cn : en);
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const money = (n) => `¥${Number(n).toFixed(2)}`;
    const matBadge = (it) => (it.ingredient_id ? '<span class="pu2-pill grey pu2-mattag">MAT</span>' : '');
    const nameLabel = (it) => `<span>${esc(it.name_en || '')}</span>`;
    const returnCell = () => '<span class="pu2-qty"></span>';
    const invoiceCell = () => '<span class="inv"></span>';
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'T', 'esc', 'money', 'matBadge', 'nameLabel', 'returnCell', 'invoiceCell',
      `${src}; return receiveRow;`
    );
    return factory(T, esc, money, matBadge, nameLabel, returnCell, invoiceCell);
  };
  return { en: make('en'), cn: make('cn') };
}

const receiveRow = liftReceiveRow();

const MATERIAL = { id: 1, ingredient_id: 77, name_en: 'Tahini', qty: 20, unit: 'kg',
                   qty_received: 15, damaged_qty: 0, stock_applied_qty: 0, cost_per_unit: 8 };
const PRODUCT  = { id: 2, ingredient_id: null, store_product_id: 5, name_en: 'Hummus 250g', qty: 20,
                   unit: 'pcs', qty_received: 20, damaged_qty: 0, stock_applied_qty: 20, cost_per_unit: 8 };

// The shipped pair, READ OUT OF THE RENDERED ROW rather than declared here, so
// these assertions cannot pass against a string this file invented.
const attrOf = (html) => { const m = html.match(/data-tt="([^"]*)"/); return m ? m[1] : null; };
const unesc = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"');

const matEn = receiveRow.en(MATERIAL, true, false);
const matCn = receiveRow.cn(MATERIAL, true, false);
const prodEn = receiveRow.en(PRODUCT, true, false);

console.log('\nBEHAVIOURAL — receiveRow() lifted from the shipped file');

// ── The tooltip is on BOTH halves of the wrong impression ──────────────────
// Either one alone leaves the other still saying "the number you typed did
// nothing", which is the whole reason the pair is on two cells.
const arrivedCellEn = (matEn.match(/<input[^>]*class="pu2-rq[^>]*>/) || [''])[0];
// The LAST cell only. An earlier draft of this matched from the first
// `<td class="right pu2-num">` — which is the ordered-qty column — through to
// the end of the row, so it swept up the Arrived input's tooltip and could not
// go red when the In-stock one was removed. Anchor on the final cell instead,
// and assert below that the anchor found something.
const stockCellEn = (matEn.match(/<td class="right pu2-num">(?:(?!<\/td>)[\s\S])*<\/td>\s*<\/tr>/) || [''])[0];
ok('BEHAVIOURAL', 'the In-stock cell was located (guards the assertion below)',
   stockCellEn.length > 0 && !stockCellEn.includes('pu2-rq'));
ok('BEHAVIOURAL', 'material row: the Arrived input carries data-tt', /data-tt=/.test(arrivedCellEn));
ok('BEHAVIOURAL', 'material row: the In-stock cell carries data-tt', /data-tt=/.test(stockCellEn));
ok('BEHAVIOURAL', 'material row: exactly two tooltips, not more',
   (matEn.match(/data-tt=/g) || []).length === 2, (matEn.match(/data-tt=/g) || []).length);

// ── Product rows get none of it ────────────────────────────────────────────
// Their Arrived box DOES move stock, so the sentence would be false on them.
ok('BEHAVIOURAL', 'product row: carries no data-tt at all', !/data-tt=/.test(prodEn));

// ── The #136 guarantee still holds ─────────────────────────────────────────
// The box itself must survive: remove it and a 15-of-20 delivery posts at 20.
ok('BEHAVIOURAL', 'material row: the Arrived input is still there',
   /class="pu2-rq/.test(matEn));
ok('BEHAVIOURAL', 'material row: a stored 15-of-20 still renders as 15',
   /class="pu2-rq[^>]*value="15"/.test(matEn));

// ── One language in the attribute, per §1.14a ──────────────────────────────
// The i18n walker in 10-extras.js splits data-tt on the first " · ". A JS-built
// two-language string, or a decorative middle dot inside a half, would be cut
// there and half the sentence thrown away.
const en = unesc(attrOf(matEn));
const cn = unesc(attrOf(matCn));
ok('BEHAVIOURAL', 'the EN render carries the English half', /^This count goes to Finance/.test(en), en);
ok('BEHAVIOURAL', 'the CN render carries the Chinese half', /^此数量会记入财务/.test(cn), cn);
ok('BEHAVIOURAL', 'EN and CN are different strings — not English on both sides', en !== cn);
ok('BEHAVIOURAL', 'the EN half contains no " · "', !en.includes(' · '), en);
ok('BEHAVIOURAL', 'the CN half contains no " · "', !cn.includes(' · '), cn);
ok('BEHAVIOURAL', 'splitting the EN half on " · " yields one part', en.split(' · ').length === 1);
ok('BEHAVIOURAL', 'splitting the CN half on " · " yields one part', cn.split(' · ').length === 1);
ok('BEHAVIOURAL', 'the CN half carries no Latin sentence text',
   !/[A-Za-z]{3,}/.test(cn), cn);
ok('BEHAVIOURAL', 'both halves are one sentence pair, not an empty attribute',
   en.length > 20 && cn.length > 10);

// ── Both cells carry the SAME string ───────────────────────────────────────
// They are two halves of one impression; two different sentences would invite
// them to drift apart.
const allAttrs = [...matEn.matchAll(/data-tt="([^"]*)"/g)].map(m => unesc(m[1]));
ok('BEHAVIOURAL', 'both cells carry the identical string',
   allAttrs.length === 2 && allAttrs[0] === allAttrs[1]);

// ── SOURCE checks, each paired with the mutation that must break it ────────
console.log('\nSOURCE — 16-purchasing.js and tacet-delivery-vocabulary.md');

const SOURCE_CHECKS = [
  { file: 'docs/tacet-delivery-vocabulary.md', src: () => DOC_SRC,
    name: 'the doc is at v1.9', anchor: '**v1.9 · 2026-09-01', present: true },
  { file: 'docs/tacet-delivery-vocabulary.md', src: () => DOC_SRC,
    name: 'the eighth amendment section exists and is LOCKED',
    anchor: "## What a material line's Arrived box does — receiving (LOCKED 2026-09-01)", present: true },
  { file: 'docs/tacet-delivery-vocabulary.md', src: () => DOC_SRC,
    name: 'the doc carries the key', anchor: '`materialArrived`', present: true },
  { file: 'docs/tacet-delivery-vocabulary.md', src: () => DOC_SRC,
    name: 'the EN half in the code appears VERBATIM in the doc', anchor: en, present: true },
  { file: 'docs/tacet-delivery-vocabulary.md', src: () => DOC_SRC,
    name: 'the CN half in the code appears VERBATIM in the doc', anchor: cn, present: true },
  { file: 'public/retail-admin/16-purchasing.js', src: () => UI_SRC,
    name: 'the tooltip is gated on ingredient_id', anchor: 'it.ingredient_id\n      ? ` data-tt=', present: true },
  { file: 'public/retail-admin/16-purchasing.js', src: () => UI_SRC,
    name: 'no PENDING_CN placeholder survives — the pair is minted, not deferred',
    anchor: 'PU_PENDING_CN', present: false },
];

for (const c of SOURCE_CHECKS) {
  const src = c.src();
  const has = src.includes(c.anchor);
  ok('SOURCE', c.name, c.present ? has : !has);
  // Mutation: prove the check can go red. For a presence check, remove the
  // anchor; for an absence check, add it.
  const mutated = c.present ? src.split(c.anchor).join('') : src + c.anchor;
  const mutatedHolds = c.present ? mutated.includes(c.anchor) : !mutated.includes(c.anchor);
  ok('SOURCE', `  ↳ mutation-tested: "${c.name}" goes red when broken`, !mutatedHolds);
}

console.log();
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All assertions held.');
