// "Free of" is offered in two places, and they must offer the same thing.
//
// WHY THIS FILE EXISTS. The Free-of flags are drawn TWICE, from two files that
// know nothing about each other: the new-product wizard builds its chips from
// PW_FREE_OF in public/retail-admin/09-products.js, and the product details
// panel has its checkboxes written by hand as markup in public/retail-admin.html.
// Both write into the same `free_of` column, keyed by id.
//
// So a flag added to one and not the other is a flag that a product can be
// given in the wizard and then silently lose the next time somebody opens the
// details panel and saves — the panel would not recognise the token, park it in
// the free-text tail, and the checkbox would never tick. Nothing goes red; the
// product just quietly stops claiming something.
//
// §148 added three entries the office had been typing by hand into that
// free-text tail — `animal products` on 75 products, `dairy` on 15, `egg` on
// 14 — which is exactly the moment the two lists can drift apart.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_SRC   = fs.readFileSync(path.join(ROOT, 'public/retail-admin/09-products.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

function fnBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) return '';
  let i = m.index + m[0].length, depth = 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(m.index, i);
}
const anchored = (src, n) => {
  const b = fnBody(src, n);
  assert.ok(b, `${n}() not found — the anchor moved, so this check proves nothing`);
  return b;
};

// The wizard's list, evaluated out of source.
function wizardList() {
  const at = JS_SRC.indexOf('const PW_FREE_OF = ');
  assert.ok(at >= 0, 'PW_FREE_OF is gone');
  const open = JS_SRC.indexOf('[', at);
  let i = open, depth = 0;
  for (; i < JS_SRC.length; i++) {
    if (JS_SRC[i] === '[') depth++;
    else if (JS_SRC[i] === ']') { depth--; if (!depth) break; }
  }
  return new Function('return ' + JS_SRC.slice(open, i + 1) + ';')();
}
// The panel's checkboxes, read out of the markup.
function panelIds() {
  const group = /<div id="pd-free-of"[\s\S]*?<\/div>/.exec(HTML_SRC);
  assert.ok(group, 'the #pd-free-of checkbox group is gone from retail-admin.html');
  return (group[0].match(/data-freeof-id="([^"]+)"/g) || [])
    .map(s => /data-freeof-id="([^"]+)"/.exec(s)[1]);
}

const WIZ = wizardList();
const PANEL = panelIds();

section('The two places that offer these flags agree');

check('the wizard and the details panel offer the SAME ids', () => {
  const w = WIZ.map(([id]) => id).sort();
  const p = [...PANEL].sort();
  assert.deepStrictEqual(p, w,
    'the two lists have drifted.\n      wizard: ' + w.join(', ') +
    '\n      panel:  ' + p.join(', ') +
    '\n      A flag in one and not the other is one a product can be given in the wizard ' +
    'and silently lose when the details panel is next saved.');
});

check('neither list offers the same id twice', () => {
  assert.strictEqual(new Set(PANEL).size, PANEL.length, 'the panel draws a checkbox twice');
  const w = WIZ.map(([id]) => id);
  assert.strictEqual(new Set(w).size, w.length, 'the wizard offers a flag twice');
});

check('every flag carries both languages', () => {
  for (const [id, en, cn] of WIZ) {
    assert.ok(en && en.trim(), id + ' has no English label');
    assert.ok(cn && cn.trim(), id + ' has no 中文 label');
    assert.ok(/[一-鿿]/.test(cn), id + ': "' + cn + '" has no CJK in its 中文 half');
  }
});

section('What gets STORED is the id, in both places');

check('the wizard writes ids, never the label it happens to be showing', () => {
  /* The panel reads ids. If the wizard wrote its visible label instead, a
     product created while the interface was in 中文 would store 无坚果, and the
     panel would not recognise it. */
  const b = anchored(JS_SRC, 'pwFreeOfStr');
  assert.ok(/map\(\(\[id\]\) => id\)/.test(b),
    'pwFreeOfStr no longer stores the id — the panel reads ids and will not recognise a label');
  assert.ok(!/cuT\(/.test(b),
    'pwFreeOfStr stores a language-dependent label, so what a product claims depends on the ' +
    'interface language of whoever created it');
});

section('The escape hatch still works, and is still the point');

check('a value that is not on the list survives a round trip', () => {
  /* This is what made the list improvable in the first place: `animal products`
     was typed by hand 75 times and the tail kept it, which is how anybody knew
     the list was missing it. Break this and the next gap is invisible. */
  const set = anchored(JS_SRC, 'pdFreeOfSet');
  assert.ok(/_pdFreeOfExtra\.push\(/.test(set), 'an unrecognised value is dropped rather than kept');
  const get = anchored(JS_SRC, 'pdFreeOfGet');
  assert.ok(/_pdFreeOfExtra/.test(get), 'the kept values are not written back out on save');
});

check('the typo fold happens on READ, and sweeps nothing', () => {
  /* `5spice` is on 16 products beside the `5 spice` checkbox's 154 — one word,
     two spellings. Folding on read ticks the box and lets the next save write
     the canonical spelling. A sweep would rewrite products nobody opened, which
     is the thing Ash said not to do: "lists only, for now". */
  const set = anchored(JS_SRC, 'pdFreeOfSet');
  assert.ok(/_PD_FREE_OF_ALIAS/.test(set), 'the alias fold is gone');
  const alias = /const _PD_FREE_OF_ALIAS = \{([\s\S]*?)\};/.exec(JS_SRC);
  assert.ok(alias, '_PD_FREE_OF_ALIAS is gone');
  const targets = (alias[1].match(/'[^']*'\s*(?=[,}])/g) || []).map(s => s.replace(/'/g, '').trim());
  const ids = new Set(PANEL);
  for (const t of targets) {
    assert.ok(ids.has(t), `the alias map folds onto "${t}", which is not a checkbox — it would vanish`);
  }
  assert.ok(/'5spice'/.test(alias[1]), 'the 5spice fold is gone, and 16 products carry that spelling');
});

section('The three §148 additions');

check('animal products, dairy and egg are offered', () => {
  const ids = new Set(WIZ.map(([id]) => id));
  for (const [id, n] of [['animal products', 75], ['dairy', 15], ['egg', 14]]) {
    assert.ok(ids.has(id),
      `"${id}" is no longer offered, and ${n} products were typing it by hand into the free-text tail`);
  }
});

check('the original four are untouched', () => {
  const ids = WIZ.map(([id]) => id);
  for (const id of ['nuts', 'soy', 'gluten', '5 spice']) {
    assert.ok(ids.includes(id), `"${id}" has left the list — 148 to 230 products carry it`);
  }
  assert.strictEqual(ids[0], 'nuts', 'the original four no longer lead the list');
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
